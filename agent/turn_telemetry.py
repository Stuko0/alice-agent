"""Per-turn harness telemetry.

One object per agent, reset at the start of every ``run_conversation`` turn,
so ``/status`` (and the log) can answer the questions that matter when judging
whether the harness is efficient: how many API round-trips did this turn take,
how much of the prompt came from cache, which tools ran and how long they took.

Deliberately tiny and allocation-free in the hot path: integer/float counters
plus a per-tool dict. No external dependency, no prompt/cache impact, and it
never raises into the agent loop.

Each finished turn is also appended to ``<ALICE_HOME>/logs/turns.jsonl`` (local
only, never sent anywhere). That file is what lets you measure harness changes
over real sessions — round-trips, cache hit rate, tool time — without parsing
the human log, and it survives ``-z`` runs where ``logging.disable()`` mutes
the console/file handlers.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


@dataclass
class ToolStat:
    count: int = 0
    seconds: float = 0.0
    errors: int = 0

    def merge(self, other: "ToolStat") -> None:
        self.count += other.count
        self.seconds += other.seconds
        self.errors += other.errors


@dataclass
class TurnTelemetry:
    """Aggregated cost/shape of the current assistant turn."""

    api_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    api_seconds: float = 0.0

    tool_calls: int = 0
    tool_errors: int = 0
    tool_seconds: float = 0.0
    tools: Dict[str, ToolStat] = field(default_factory=dict)

    def reset(self) -> "TurnTelemetry":
        self.api_calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cache_read_tokens = 0
        self.cache_write_tokens = 0
        self.reasoning_tokens = 0
        self.api_seconds = 0.0
        self.tool_calls = 0
        self.tool_errors = 0
        self.tool_seconds = 0.0
        self.tools = {}
        return self

    # ── recording ───────────────────────────────────────────────────────
    def record_api(
        self,
        *,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        reasoning_tokens: int = 0,
        seconds: float = 0.0,
    ) -> None:
        self.api_calls += 1
        self.prompt_tokens += int(prompt_tokens or 0)
        self.completion_tokens += int(completion_tokens or 0)
        self.cache_read_tokens += int(cache_read_tokens or 0)
        self.cache_write_tokens += int(cache_write_tokens or 0)
        self.reasoning_tokens += int(reasoning_tokens or 0)
        try:
            self.api_seconds += float(seconds or 0.0)
        except (TypeError, ValueError):
            pass

    def record_tool(self, name: str, seconds: float, is_error: bool = False) -> None:
        try:
            duration = float(seconds or 0.0)
        except (TypeError, ValueError):
            duration = 0.0
        stat = self.tools.get(name)
        if stat is None:
            stat = ToolStat()
            self.tools[name] = stat
        stat.count += 1
        stat.seconds += duration
        if is_error:
            stat.errors += 1
        self.tool_calls += 1
        self.tool_seconds += duration
        if is_error:
            self.tool_errors += 1

    # ── reporting ───────────────────────────────────────────────────────
    @property
    def cache_hit_pct(self) -> float:
        if not self.prompt_tokens:
            return 0.0
        return 100.0 * self.cache_read_tokens / self.prompt_tokens

    @property
    def has_activity(self) -> bool:
        return bool(self.api_calls or self.tool_calls)

    def top_tools(self, limit: int = 3) -> list[tuple[str, ToolStat]]:
        return sorted(self.tools.items(), key=lambda kv: kv[1].seconds, reverse=True)[:limit]

    def summary_line(self) -> str:
        """One compact line, e.g. for the log or /status."""
        parts = [
            f"turn: {self.api_calls} api call{'s' if self.api_calls != 1 else ''}",
            f"in={self.prompt_tokens:,} out={self.completion_tokens:,}",
        ]
        if self.prompt_tokens:
            parts.append(f"cache={self.cache_hit_pct:.0f}%")
        if self.reasoning_tokens:
            parts.append(f"reasoning={self.reasoning_tokens:,}")
        if self.tool_calls:
            tool_part = f"tools={self.tool_calls} ({self.tool_seconds:.1f}s)"
            if self.tool_errors:
                tool_part += f" errors={self.tool_errors}"
            parts.append(tool_part)
        return " | ".join(parts)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "api_calls": self.api_calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "cache_hit_pct": round(self.cache_hit_pct, 1),
            "api_seconds": round(self.api_seconds, 2),
            "tool_calls": self.tool_calls,
            "tool_errors": self.tool_errors,
            "tool_seconds": round(self.tool_seconds, 2),
            "tools": {
                name: {
                    "count": stat.count,
                    "seconds": round(stat.seconds, 2),
                    "errors": stat.errors,
                }
                for name, stat in self.tools.items()
            },
        }


def get_telemetry(agent) -> Optional[TurnTelemetry]:
    """The agent's telemetry object, or None for agents built before this."""
    return getattr(agent, "_turn_telemetry", None)


def begin_turn(agent) -> TurnTelemetry:
    """Reset (or lazily create) the per-turn telemetry."""
    telemetry = getattr(agent, "_turn_telemetry", None)
    if telemetry is None:
        telemetry = TurnTelemetry()
        try:
            agent._turn_telemetry = telemetry
        except Exception:  # pragma: no cover — exotic agent proxies
            return telemetry
    return telemetry.reset()


_TURNS_LOG_MAX_BYTES = 5_000_000


def _append_turn_record(agent, snapshot: Dict[str, Any]) -> None:
    """Append one JSON line to ``<ALICE_HOME>/logs/turns.jsonl`` (best effort)."""
    try:
        from alice_constants import get_alice_home

        log_dir = get_alice_home() / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / "turns.jsonl"
        if path.exists() and path.stat().st_size > _TURNS_LOG_MAX_BYTES:
            os.replace(path, log_dir / "turns.jsonl.1")
        record = {
            "ts": round(time.time(), 3),
            "session_id": getattr(agent, "session_id", None),
            "platform": getattr(agent, "platform", None),
            "model": getattr(agent, "model", None),
            "provider": getattr(agent, "provider", None),
            **snapshot,
        }
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n")
    except Exception:  # pragma: no cover — telemetry must never break a turn
        pass


def finish_turn(agent) -> Optional[Dict[str, Any]]:
    """Log the turn summary, persist it, and stash it on the agent. Never raises."""
    telemetry = getattr(agent, "_turn_telemetry", None)
    if telemetry is None or not telemetry.has_activity:
        return None
    try:
        logger.info("%s", telemetry.summary_line())
        snapshot = telemetry.as_dict()
        agent.last_turn_telemetry = snapshot
        _append_turn_record(agent, snapshot)
        return snapshot
    except Exception:  # pragma: no cover
        return None
