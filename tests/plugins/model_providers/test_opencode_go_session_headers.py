"""OpenCode Go x-opencode-session header — regression tests.

The OpenCode Go relay 400s with ``MissingSessionID`` when a request lacks
``x-opencode-session`` and uses the ID for routing + prompt-cache affinity
(https://opencode.ai/docs/go/#where-can-i-use-it). These tests pin the
behavioral contract:

- profile.default_headers carries a session header (OpenAI client path)
- the Anthropic-path client (MiniMax/Qwen via /v1/messages) carries it too
- the ID is stable within a process (main + auxiliary share one session)
- the ID is namespaced to Alice (``alice-`` prefix) and present in UA form
- non-OpenCode endpoints never receive the header
"""

from __future__ import annotations

import pytest


@pytest.fixture
def opencode_go_profile():
    """Resolve the registered OpenCode Go provider profile."""
    import model_tools  # noqa: F401
    import providers

    profile = providers.get_provider_profile("opencode-go")
    assert profile is not None, "opencode-go provider profile must be registered"
    return profile


class TestOpenCodeGoSessionHeaders:
    """x-opencode-session must ride on every OpenCode Go request path."""

    def test_profile_carries_session_header(self, opencode_go_profile):
        headers = opencode_go_profile.default_headers
        assert "x-opencode-session" in headers
        assert headers["x-opencode-session"].startswith("alice-")

    def test_profile_carries_identifying_user_agent(self, opencode_go_profile):
        # OpenCode asks non-OpenCode clients to identify themselves with
        # their own UA rather than a generic SDK name.
        ua = opencode_go_profile.default_headers.get("User-Agent", "")
        assert ua.startswith("alice-cli/"), ua

    def test_session_id_stable_across_profile_lookups(self):
        import model_tools  # noqa: F401
        import providers

        first = providers.get_provider_profile("opencode-go")
        second = providers.get_provider_profile("opencode-go")
        assert first is not None and second is not None
        assert (
            first.default_headers["x-opencode-session"]
            == second.default_headers["x-opencode-session"]
        )

    def test_zen_profile_does_not_carry_go_session_header(self):
        import model_tools  # noqa: F401
        import providers

        zen = providers.get_provider_profile("opencode-zen")
        assert "x-opencode-session" not in (zen.default_headers or {})


class TestOpenCodeGoAnthropicPathHeaders:
    """MiniMax/Qwen ride the Anthropic Messages surface of the relay."""

    @pytest.fixture
    def anthropic_cls(self):
        pytest.importorskip("anthropic")
        from agent.anthropic_adapter import build_anthropic_client

        return build_anthropic_client

    def test_anthropic_client_gets_session_header(self, anthropic_cls):
        client = anthropic_cls("sk-test", "https://opencode.ai/zen/go/v1")
        custom = client._custom_headers or {}
        assert custom.get("x-opencode-session", "").startswith("alice-")

    def test_anthropic_session_matches_profile_session(self, anthropic_cls, opencode_go_profile):
        # Main (OpenAI-wire) and Anthropic-path clients must share ONE
        # session ID so the relay's prompt-cache affinity holds.
        client = anthropic_cls("sk-test", "https://opencode.ai/zen/go/v1")
        assert (
            client._custom_headers["x-opencode-session"]
            == opencode_go_profile.default_headers["x-opencode-session"]
        )

    def test_session_stable_across_client_rebuilds(self, anthropic_cls):
        # Client rebuilds happen on credential refresh — the session must
        # survive them or cache affinity resets mid-conversation.
        first = anthropic_cls("sk-test", "https://opencode.ai/zen/go/v1")
        second = anthropic_cls("sk-other", "https://opencode.ai/zen/go")
        assert (
            first._custom_headers["x-opencode-session"]
            == second._custom_headers["x-opencode-session"]
        )

    @pytest.mark.parametrize(
        "base_url",
        [
            "https://api.anthropic.com",
            "https://api.minimax.io/anthropic",
            "https://opencode.ai/zen/v1",  # Zen relay — not the Go relay
            None,
        ],
    )
    def test_non_go_endpoints_do_not_get_session_header(self, anthropic_cls, base_url):
        client = anthropic_cls("sk-test", base_url)
        assert "x-opencode-session" not in (client._custom_headers or {})
