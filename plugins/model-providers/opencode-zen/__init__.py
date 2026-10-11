"""OpenCode provider profiles (Zen + Go).

Both use per-model api_mode routing:
  - OpenCode Zen: Claude → anthropic_messages, GPT-5/Codex → codex_responses,
    everything else → chat_completions (this profile)
  - OpenCode Go: MiniMax → anthropic_messages, GLM/Kimi → chat_completions
    (this profile)
"""

from __future__ import annotations

import uuid
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile


def _flat_model_name(model: str | None) -> str:
    """Return the bare OpenCode model ID, tolerating aggregator prefixes."""
    return (model or "").strip().rsplit("/", 1)[-1].lower()


def _is_kimi_k2_model(model: str | None) -> bool:
    return _flat_model_name(model).startswith("kimi-k2")


def _is_deepseek_thinking_model(model: str | None) -> bool:
    m = _flat_model_name(model)
    if m.startswith("deepseek-v") and not m.startswith("deepseek-v3"):
        return True
    return m == "deepseek-reasoner"


_OPENCODE_SESSION_ID: str | None = None


def _opencode_session_id() -> str:
    """Stable per-process session ID for the ``x-opencode-session`` header.

    OpenCode Go requires a session identifier on every request so the relay
    can optimize routing and prompt caching. The ID must be *stable across
    requests within a conversation* — a per-request UUID would defeat the
    relay's prompt-cache affinity — but distinct per process so parallel
    Alice sessions don't share a cache bucket.

    A lazily-minted module singleton satisfies both: all requests from this
    Alice process reuse one ID, and each new process (CLI run, gateway worker,
    cron tick) gets a fresh one.
    """
    global _OPENCODE_SESSION_ID
    if _OPENCODE_SESSION_ID is None:
        _OPENCODE_SESSION_ID = f"alice-{uuid.uuid4().hex[:16]}"
    return _OPENCODE_SESSION_ID


def opencode_go_session_headers() -> dict[str, str]:
    """Headers OpenCode Go requires on every request (main + auxiliary).

    - ``x-opencode-session``: stable session ID for routing + prompt-cache
      affinity. The relay 400s with ``MissingSessionID`` when absent.
      https://opencode.ai/docs/go/#where-can-i-use-it
    - ``User-Agent``: a client-identifying UA — OpenCode asks non-OpenCode
      clients to identify themselves instead of a generic SDK name.
    """
    headers = {"x-opencode-session": _opencode_session_id()}
    try:
        from providers.base import _profile_user_agent

        headers["User-Agent"] = _profile_user_agent()
    except Exception:
        pass
    return headers


class OpenCodeGoProfile(ProviderProfile):
    """OpenCode Go - model-specific reasoning controls."""

    # Per-model completion-token cap. The opencode-go relay's default is
    # too large for mimo-v2.5-pro — it sends max_tokens=262144 but Xiaomi
    # only supports 131072 completion tokens and 400s the request.
    # Setting an explicit cap here prevents the relay default from being
    # applied. Keys are normalized via _flat_model_name().
    _MODEL_MAX_TOKENS: dict[str, int] = {
        "mimo-v2.5-pro": 131072,
    }

    def get_max_tokens(self, model: str | None) -> int | None:
        cap = self._MODEL_MAX_TOKENS.get(_flat_model_name(model))
        if cap is not None:
            return cap
        return self.default_max_tokens

    def build_api_kwargs_extras(
        self, *, reasoning_config: dict | None = None, model: str | None = None, **context
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        extra_body: dict[str, Any] = {}
        top_level: dict[str, Any] = {}

        if _is_kimi_k2_model(model):
            # Kimi K2 on OpenCode Go uses Moonshot's native wire shape:
            # extra_body.thinking (binary toggle) + top-level reasoning_effort
            # (low|medium|high). Mirrors the KimiProfile (api.moonshot.ai/v1).
            if not isinstance(reasoning_config, dict):
                # No config → leave server defaults alone.
                return extra_body, top_level

            enabled = reasoning_config.get("enabled") is not False
            if not enabled:
                extra_body["thinking"] = {"type": "disabled"}
                return extra_body, top_level

            effort = (reasoning_config.get("effort") or "").strip().lower()
            if effort in {"xhigh", "max"}:
                top_level["reasoning_effort"] = "high"
            elif effort in {"low", "medium", "high"}:
                top_level["reasoning_effort"] = effort

            # Avoid "cannot specify both 'thinking' and 'reasoning_effort'" HTTP 400:
            # only send extra_body["thinking"] when no reasoning_effort is set.
            if "reasoning_effort" not in top_level:
                extra_body["thinking"] = {"type": "enabled"}
            return extra_body, top_level

        if not _is_deepseek_thinking_model(model):
            return extra_body, top_level

        enabled = True
        if isinstance(reasoning_config, dict) and reasoning_config.get("enabled") is False:
            enabled = False

        if not enabled:
            extra_body["thinking"] = {"type": "disabled"}
            return extra_body, top_level

        if isinstance(reasoning_config, dict):
            effort = (reasoning_config.get("effort") or "").strip().lower()
            if effort in {"xhigh", "max"}:
                top_level["reasoning_effort"] = "max"
            elif effort in {"low", "medium", "high"}:
                top_level["reasoning_effort"] = effort

        # Avoid "cannot specify both 'thinking' and 'reasoning_effort'" HTTP 400:
        # only send extra_body["thinking"] when no reasoning_effort is set.
        if "reasoning_effort" not in top_level:
            extra_body["thinking"] = {"type": "enabled"}

        return extra_body, top_level


opencode_zen = ProviderProfile(
    name="opencode-zen",
    aliases=("opencode", "opencode_zen", "zen"),
    env_vars=("OPENCODE_ZEN_API_KEY",),
    base_url="https://opencode.ai/zen/v1",
    default_aux_model="gemini-3-flash",
)

opencode_go = OpenCodeGoProfile(
    name="opencode-go",
    aliases=("opencode_go", "go", "opencode-go-sub"),
    env_vars=("OPENCODE_GO_API_KEY",),
    base_url="https://opencode.ai/zen/go/v1",
    default_aux_model="glm-5",
    # OpenCode Go requires a stable session header on every request (main +
    # auxiliary) — the relay 400s with MissingSessionID without it, and uses
    # the ID for routing + prompt-cache affinity. Set at instantiation (not
    # in __post_init__: the dataclass-generated __init__ does not invoke it)
    # so run_agent.py / auxiliary_client.py merge these into the OpenAI
    # client via profile.default_headers.
    default_headers=opencode_go_session_headers(),
)

register_provider(opencode_zen)
register_provider(opencode_go)
