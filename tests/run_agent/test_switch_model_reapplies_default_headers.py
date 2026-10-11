"""Regression tests: switch_model must re-apply provider default headers.

``switch_model`` (agent/agent_runtime_helpers.py) rebuilds the OpenAI
client for chat_completions targets from bare ``{api_key, base_url}``
kwargs. Every other client-rebuild path — agent init
(agent_init.py:844-852), credential rotation (run_agent.py:4204), fallback
(chat_completion_helpers.py:1347-1353) — re-applies the provider header
ladder (URL-specific headers, then ``profile.default_headers``, then user
``model.default_headers``). The switch path did not, so an in-place
``/model`` switch to a header-requiring provider rebuilt a bare client
and the next turn failed:

- opencode-go → HTTP 400 ``MissingSessionID`` (the relay requires
  ``x-opencode-session`` from ``profile.default_headers`` on every
  request; verified live in agent.log 2026-09-07 17:42-17:46 — 400s on
  every /model switch to omen-alpha/mimo-v2.5 in a post-fix serve
  process, because the header only reached clients built at init).

These tests pin the contract that the switch path consults the SAME
ladder: the stored ``agent._client_kwargs`` and the kwargs handed to
``_create_openai_client`` both carry the provider headers.
"""

from unittest.mock import MagicMock, patch

from agent.agent_runtime_helpers import switch_model
from run_agent import AIAgent


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_agent(current_provider, current_model):
    """Bare agent object with the minimum attributes switch_model touches.

    Mirrors ``tests/run_agent/test_switch_model_pool_reload_52727.py``.
    ``_apply_client_headers_for_base_url`` is bound to the REAL AIAgent
    method so the header ladder itself is exercised — only the client
    construction / policy calls around it stay mocked.
    """
    agent = MagicMock(name=f"Agent[{current_provider}]")
    agent.provider = current_provider
    agent.model = current_model
    agent.base_url = f"https://{current_provider}.example/v1"
    agent.api_key = f"{current_provider}-key"
    agent.api_mode = "chat_completions"
    agent.client = MagicMock(name="Client")
    agent._client_kwargs = {
        "api_key": "***",
        "base_url": f"https://{current_provider}.example/v1",
    }
    agent._anthropic_client = None
    agent._anthropic_api_key = ""
    agent._anthropic_base_url = None
    agent._is_anthropic_oauth = False
    agent._config_context_length = None
    agent._transport_cache = {}
    agent._cached_system_prompt = "cached-system-prompt"
    agent.context_compressor = None
    agent._use_prompt_caching = False
    agent._use_native_cache_layout = False
    agent._primary_runtime = {}
    agent._fallback_activated = False
    agent._fallback_index = 0
    agent._fallback_chain = []
    agent._fallback_model = None
    agent._credential_pool = None
    agent._anthropic_prompt_cache_policy = MagicMock(return_value=(False, False))
    agent._ensure_lmstudio_runtime_loaded = MagicMock()
    # Bind the real header ladder — the code under test for these tests.
    agent._apply_client_headers_for_base_url = (
        AIAgent._apply_client_headers_for_base_url.__get__(agent)
    )
    # _apply_user_default_headers is called at the end of the ladder; the
    # real one reads user config (empty under the isolated ALICE_HOME),
    # but on a bare mock it stays a no-op — bind it to keep the ladder cheap.
    agent._apply_user_default_headers = MagicMock(return_value=None)
    return agent


def _client_headers_passed_to_create(agent):
    """default_headers handed to _create_openai_client on the switch call."""
    assert agent._create_openai_client.called
    kwargs = agent._create_openai_client.call_args.args[0]
    return (kwargs or {}).get("default_headers") or {}


# ---------------------------------------------------------------------------
# the fix
# ---------------------------------------------------------------------------


class TestSwitchModelReappliesDefaultHeaders:
    """The in-place /model switch must not rebuild a bare client."""

    def test_switch_to_opencode_go_carries_session_header(self):
        """custom -> opencode-go: rebuilt kwargs keep x-opencode-session.

        This is the exact sequence from agent.log 2026-09-07 17:42 — a
        /model switch to omen-alpha produced a bare client and the next
        turn 400'd with MissingSessionID.
        """
        import model_tools  # noqa: F401  — registers provider profiles

        agent = _make_agent("custom", "z-ai/glm-5.3-free")

        with patch("agent.credential_pool.load_pool", return_value=MagicMock(provider="opencode-go")):
            switch_model(
                agent,
                new_model="omen-alpha",
                new_provider="opencode-go",
                api_key="go-key",
                base_url="https://opencode.ai/zen/go/v1",
                api_mode="chat_completions",
            )

        stored = agent._client_kwargs.get("default_headers") or {}
        assert stored.get("x-opencode-session", "").startswith("alice-")
        passed = _client_headers_passed_to_create(agent)
        assert passed.get("x-opencode-session", "").startswith("alice-")
        # One session across init-built and switch-built clients — the
        # relay uses the ID for prompt-cache affinity, so it must match
        # the profile's.
        import providers

        profile = providers.get_provider_profile("opencode-go")
        assert (
            passed["x-opencode-session"]
            == profile.default_headers["x-opencode-session"]
        )

    def test_switch_within_opencode_go_keeps_session_header(self):
        """opencode-go -> opencode-go (omen -> mimo) must not drop headers."""
        import model_tools  # noqa: F401

        agent = _make_agent("opencode-go", "omen-alpha")
        agent.base_url = "https://opencode.ai/zen/go/v1"

        switch_model(
            agent,
            new_model="mimo-v2.5",
            new_provider="opencode-go",
            api_key="go-key",
            base_url="https://opencode.ai/zen/go/v1",
            api_mode="chat_completions",
        )

        passed = _client_headers_passed_to_create(agent)
        assert passed.get("x-opencode-session", "").startswith("alice-")
        stored = agent._client_kwargs.get("default_headers") or {}
        assert stored.get("x-opencode-session", "").startswith("alice-")

    def test_switch_to_kimi_url_carries_user_agent_header(self):
        """The URL-specific branch of the ladder also survives switches.

        api.kimi.com requires the claude-code UA sentinel; the ladder's
        first branch must be consulted on switch, not just at init.
        """
        agent = _make_agent("custom", "z-ai/glm-5.3-free")

        with patch("agent.credential_pool.load_pool", return_value=MagicMock(provider="kimi")):
            switch_model(
                agent,
                new_model="kimi-k2.6",
                new_provider="kimi",
                api_key="kimi-key",
                base_url="https://api.kimi.com/v1",
                api_mode="chat_completions",
            )

        passed = _client_headers_passed_to_create(agent)
        assert passed.get("User-Agent") == "claude-code/0.1.0"
        assert agent._client_kwargs["default_headers"]["User-Agent"] == "claude-code/0.1.0"

    def test_header_ladder_failure_does_not_break_the_switch(self):
        """A header-ladder exception must not roll back the whole swap.

        The ladder is wrapped defensively: a provider-lookup error degrades
        to a bare client (pre-fix behavior) instead of failing the switch.
        """
        agent = _make_agent("custom", "z-ai/glm-5.3-free")
        agent._apply_client_headers_for_base_url = MagicMock(
            side_effect=RuntimeError("ladder exploded")
        )

        with patch("agent.credential_pool.load_pool", return_value=MagicMock(provider="kimi")):
            switch_model(
                agent,
                new_model="kimi-k2.6",
                new_provider="kimi",
                api_key="kimi-key",
                base_url="https://api.kimi.com/v1",
                api_mode="chat_completions",
            )

        # Switch still completed: new client built with bare kwargs.
        assert agent._create_openai_client.called
        assert "default_headers" not in (agent._create_openai_client.call_args.args[0] or {})

    def test_switch_to_plain_provider_stays_headerless(self):
        """Providers without header requirements keep bare kwargs — no
        default_headers key is fabricated for them."""
        agent = _make_agent("custom", "z-ai/glm-5.3-free")

        with patch("agent.credential_pool.load_pool", return_value=MagicMock(provider="groq")):
            switch_model(
                agent,
                new_model="llama-3.3-70b",
                new_provider="groq",
                api_key="groq-key",
                base_url="https://api.groq.com/openai/v1",
                api_mode="chat_completions",
            )

        assert "default_headers" not in agent._client_kwargs
