"""The missing-provider message must match the surface running Alice.

A desktop install has no terminal to run `alice model` in; pointing there was a
dead end on Windows (reported by users of the desktop-only build). The renderer
also opens the provider picker when it sees this text.
"""

import importlib

from agent.agent_init import no_provider_message


def test_desktop_message_points_at_settings(monkeypatch):
    monkeypatch.setenv("ALICE_DESKTOP", "1")

    message = no_provider_message()

    assert "Settings" in message
    assert "alice model" not in message
    assert "alice setup" not in message


def test_cli_message_keeps_the_command_hint(monkeypatch):
    monkeypatch.delenv("ALICE_DESKTOP", raising=False)

    message = no_provider_message()

    assert "alice model" in message
    assert "alice setup" in message
