"""P2 harness work: per-turn telemetry, skill-declared toolsets, arg streaming."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from agent.skill_utils import extract_skill_toolsets, skill_toolsets_for  # noqa: E402
from agent.turn_telemetry import (  # noqa: E402
    TurnTelemetry,
    begin_turn,
    finish_turn,
)


def _tool_defs(*names):
    return [
        {"type": "function", "function": {"name": n, "description": n, "parameters": {"type": "object", "properties": {}}}}
        for n in names
    ]


# ── Telemetry ───────────────────────────────────────────────────────────

class TestTurnTelemetry:
    def test_records_api_and_tools(self):
        tel = TurnTelemetry()
        tel.record_api(
            prompt_tokens=1_000,
            completion_tokens=100,
            cache_read_tokens=800,
            reasoning_tokens=40,
            seconds=1.5,
        )
        tel.record_tool("read_file", 0.25)
        tel.record_tool("read_file", 0.75)
        tel.record_tool("patch", 2.0, is_error=True)

        assert tel.api_calls == 1
        assert tel.prompt_tokens == 1_000
        assert tel.completion_tokens == 100
        assert tel.cache_hit_pct == 80.0
        assert tel.tool_calls == 3
        assert tel.tool_errors == 1
        assert tel.tools["read_file"].count == 2
        assert tel.tools["read_file"].seconds == pytest.approx(1.0)
        assert tel.top_tools(1)[0][0] == "patch"

    def test_summary_line_is_informative_and_compact(self):
        tel = TurnTelemetry()
        tel.record_api(prompt_tokens=2_000, completion_tokens=120, cache_read_tokens=1_500)
        tel.record_tool("terminal", 0.4)
        tel.record_tool("terminal", 0.6, is_error=True)

        line = tel.summary_line()

        assert "1 api call" in line
        assert "cache=75%" in line
        assert "tools=2 (1.0s)" in line
        assert "errors=1" in line
        assert len(line) < 160

    def test_as_dict_round_trips(self):
        tel = TurnTelemetry()
        tel.record_api(prompt_tokens=10, completion_tokens=2)
        tel.record_tool("todo", 0.1)

        data = tel.as_dict()

        assert data["api_calls"] == 1
        assert data["tools"]["todo"]["count"] == 1
        json.dumps(data)  # must be serializable for /status + logs

    def test_begin_turn_resets_and_finish_turn_stashes(self):
        agent = SimpleNamespace()
        begin_turn(agent)
        agent._turn_telemetry.record_api(prompt_tokens=5)

        begin_turn(agent)
        assert agent._turn_telemetry.prompt_tokens == 0

        agent._turn_telemetry.record_api(prompt_tokens=7, completion_tokens=3)
        snapshot = finish_turn(agent)

        assert snapshot["prompt_tokens"] == 7
        assert agent.last_turn_telemetry == snapshot

    def test_finish_turn_appends_a_jsonl_record(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        agent = SimpleNamespace(session_id="s1", platform="cli", model="m", provider="p")
        begin_turn(agent)
        agent._turn_telemetry.record_api(prompt_tokens=10, completion_tokens=2)
        agent._turn_telemetry.record_tool("todo", 0.1)

        finish_turn(agent)

        lines = (tmp_path / "logs" / "turns.jsonl").read_text().splitlines()
        assert len(lines) == 1
        record = json.loads(lines[0])
        assert record["session_id"] == "s1"
        assert record["prompt_tokens"] == 10
        assert record["tools"]["todo"]["count"] == 1

    def test_idle_turn_produces_no_snapshot(self):
        agent = SimpleNamespace()
        begin_turn(agent)
        assert finish_turn(agent) is None
        assert getattr(agent, "last_turn_telemetry", None) is None


class TestTelemetryInTheLoop:
    """Integration: a real turn records usage and tool timings."""

    @staticmethod
    def _agent(tmp_path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        import run_agent

        with (
            patch("run_agent.get_tool_definitions", return_value=_tool_defs("web_search")),
            patch("run_agent.check_toolset_requirements", return_value={}),
            patch("run_agent.OpenAI"),
        ):
            agent = run_agent.AIAgent(
                api_key="test-key-0000000000",
                base_url="http://127.0.0.1:1/v1",
                quiet_mode=True,
                skip_context_files=True,
                skip_memory=True,
            )
        agent.client = MagicMock()
        agent._cached_system_prompt = "You are helpful."
        agent._use_prompt_caching = False
        agent.tool_delay = 0
        agent.compression_enabled = False
        agent.save_trajectories = False
        return agent

    def test_records_tokens_and_tool_calls(self, tmp_path, monkeypatch):
        agent = self._agent(tmp_path, monkeypatch)

        from tests.run_agent.test_run_agent import _mock_response, _mock_tool_call

        tool_call = _mock_tool_call("web_search", '{"q":"x"}', call_id="c1")
        first = _mock_response(
            content=None,
            finish_reason="tool_calls",
            tool_calls=[tool_call],
            usage={"prompt_tokens": 1_200, "completion_tokens": 80, "total_tokens": 1_280},
        )
        second = _mock_response(
            content="done",
            finish_reason="stop",
            usage={"prompt_tokens": 1_300, "completion_tokens": 20, "total_tokens": 1_320},
        )
        agent.client.chat.completions.create.side_effect = [first, second]

        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
            patch("run_agent.handle_function_call", return_value="ok"),
        ):
            result = agent.run_conversation("search something")

        assert result["completed"] is True
        tel = agent.last_turn_telemetry
        assert tel is not None
        assert tel["api_calls"] == 2
        assert tel["prompt_tokens"] == 2_500
        assert tel["completion_tokens"] == 100
        assert tel["tool_calls"] == 1
        assert "web_search" in tel["tools"]


class TestStatusRendering:
    def test_status_shows_the_last_turn(self, capsys):
        """The /status block must render the telemetry without raising."""
        from datetime import datetime

        from cli import AliceCLI

        cli = AliceCLI.__new__(AliceCLI)
        cli.session_id = "s1"
        cli._session_db = None
        cli.session_start = datetime(2026, 1, 1, 12, 0)
        cli.provider = "custom"
        cli.model = "fake/model"
        cli._agent_running = False
        cli.agent = SimpleNamespace(
            session_total_tokens=1_234,
            last_turn_telemetry={
                "api_calls": 2,
                "prompt_tokens": 1_000,
                "completion_tokens": 50,
                "cache_hit_pct": 80.0,
                "tool_calls": 3,
                "tool_seconds": 1.5,
                "tool_errors": 0,
                "tools": {
                    "read_file": {"count": 2, "seconds": 1.0, "errors": 0},
                    "patch": {"count": 1, "seconds": 0.5, "errors": 0},
                },
            },
        )
        cli._console_print = lambda text, **kwargs: print(text)

        cli._show_session_status()

        out = capsys.readouterr().out
        assert "Last turn:" in out
        assert "API calls: 2" in out
        assert "Cache read: 80%" in out
        assert "read_file: 2x" in out


# ── Skills declare toolsets ─────────────────────────────────────────────

class TestSkillToolsets:
    def test_reads_top_level_list(self):
        assert extract_skill_toolsets({"toolsets": ["browser", "web"]}) == [
            "browser",
            "web",
        ]

    def test_reads_metadata_and_comma_string(self):
        fm = {"metadata": {"alice": {"toolsets": "browser, web ,browser"}}}
        assert extract_skill_toolsets(fm) == ["browser", "web"]

    def test_absent_or_malformed(self):
        assert extract_skill_toolsets({}) == []
        assert extract_skill_toolsets({"toolsets": 42}) == []
        assert extract_skill_toolsets({"toolsets": None}) == []

    def test_scan_unions_declared_toolsets(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        skills = tmp_path / "skills"
        for name, toolsets in (("browser-work", ["browser"]), ("research", ["web", "browser"])):
            d = skills / name
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(
                "---\n"
                f"name: {name}\n"
                "description: test\n"
                f"toolsets: {json.dumps(toolsets)}\n"
                "---\n\n# test\n",
                encoding="utf-8",
            )

        from agent.skill_utils import get_all_skills_dirs

        monkeypatch.setattr(
            "agent.skill_utils.get_all_skills_dirs", lambda: [skills], raising=True
        )
        assert skills in get_all_skills_dirs()

        assert skill_toolsets_for(["browser-work"]) == ["browser"]
        assert skill_toolsets_for(["research", "browser-work"]) == ["web", "browser"]
        assert skill_toolsets_for(["does-not-exist"]) == []
        # Only real toolsets get activated (validated by the caller).
        from toolsets import validate_toolset

        assert validate_toolset("browser") is True
        assert validate_toolset("not-a-toolset") is False

        # The CLI decision point: declared toolsets are unioned into the
        # session selection before the agent (and its schema) is built.
        from cli import _apply_skill_toolsets

        selected = _apply_skill_toolsets(["research"], ["file", "web"])
        assert selected == ["file", "web", "browser"]
        # A skill with no declaration leaves the selection untouched.
        (skills / "plain").mkdir()
        (skills / "plain" / "SKILL.md").write_text(
            "---\nname: plain\ndescription: test\n---\n\n# t\n", encoding="utf-8"
        )
        assert _apply_skill_toolsets(["plain"], ["file"]) == ["file"]


# ── Tool-argument streaming ─────────────────────────────────────────────

class TestToolArgsStreaming:
    def test_throttles_to_one_event_per_512_chars(self):
        from run_agent import AIAgent

        seen = []
        agent = SimpleNamespace(tool_args_callback=lambda name, partial: seen.append(len(partial)))
        agent._tool_args_emit_state = {}

        AIAgent._fire_tool_args_delta(agent, "patch", "x" * 100)   # below
        AIAgent._fire_tool_args_delta(agent, "patch", "x" * 600)   # fires
        AIAgent._fire_tool_args_delta(agent, "patch", "x" * 700)   # below (100 new)
        AIAgent._fire_tool_args_delta(agent, "patch", "x" * 1_200)  # fires

        assert seen == [600, 1_200]

    def test_no_callback_is_a_noop(self):
        from run_agent import AIAgent

        agent = SimpleNamespace(tool_args_callback=None)
        AIAgent._fire_tool_args_delta(agent, "patch", "x" * 10_000)  # must not raise

    def test_gateway_emits_tool_args_event(self):
        from tui_gateway import server

        emitted = []

        with (
            patch.object(server, "_tool_progress_enabled", return_value=True),
            patch.object(server, "_emit", side_effect=lambda *a: emitted.append(a)),
        ):
            cb = server._agent_cbs("sid")["tool_args_callback"]
            cb("patch", "y" * 900)

        assert emitted, "no tool.args event emitted"
        event, sid, payload = emitted[0]
        assert event == "tool.args"
        assert sid == "sid"
        assert payload["name"] == "patch"
        assert payload["chars"] == 900
        assert payload["preview"].endswith("y")

    def test_cli_updates_a_single_line(self, capsys):
        from cli import AliceCLI

        cli = AliceCLI.__new__(AliceCLI)
        cli.streaming_enabled = True

        AliceCLI._on_tool_args_delta(cli, "write_file", "z" * 2_048)

        out = capsys.readouterr().out
        assert "preparing write_file" in out
        assert "2.0 KB" in out
        assert out.startswith("\r")
        assert "\x1b[K" not in out  # AGENTS.md: never erase-to-EOL
