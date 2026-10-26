"""Tests for Slack CLI helpers."""

import argparse

from alice_cli.slack_cli import _build_full_manifest
from alice_cli.subcommands.slack import build_slack_parser


def _parse_slack_args(argv):
    """Build the real `alice slack` parser and parse argv against it."""
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    build_slack_parser(subparsers, cmd_slack=lambda _args: 0)
    return parser.parse_args(argv)


class TestSlackManifestArgparse:
    """The `--no-assistant` flag wires through argparse to `no_assistant`."""

    def test_no_assistant_flag_defaults_false(self):
        args = _parse_slack_args(["slack", "manifest"])
        assert getattr(args, "no_assistant", False) is False

    def test_no_assistant_flag_sets_true(self):
        args = _parse_slack_args(["slack", "manifest", "--no-assistant"])
        assert args.no_assistant is True



class TestSlackFullManifest:
    """Generated full Slack app manifest used by `alice slack manifest`."""

    def test_app_home_messages_are_writable(self):
        manifest = _build_full_manifest("Alice", "Your Alice Agent on Slack")

        assert manifest["features"]["app_home"] == {
            "home_tab_enabled": False,
            "messages_tab_enabled": True,
            "messages_tab_read_only_enabled": False,
        }

    def test_private_channel_directory_scope_is_included(self):
        manifest = _build_full_manifest("Alice", "Your Alice Agent on Slack")

        bot_scopes = manifest["oauth_config"]["scopes"]["bot"]
        assert "groups:read" in bot_scopes

    def test_group_dm_scopes_and_event_are_included(self):
        """Group DMs (mpim) need message.mpim + mpim:history or Slack never
        delivers them — the adapter classifies mpim as a DM and replies
        ambiently, but only if the event reaches the bot at all."""
        manifest = _build_full_manifest("Alice", "Your Alice Agent on Slack")

        bot_scopes = manifest["oauth_config"]["scopes"]["bot"]
        bot_events = manifest["settings"]["event_subscriptions"]["bot_events"]

        # The event is the load-bearing piece: without message.mpim Slack
        # drops group-DM messages before the adapter sees them.
        assert "message.mpim" in bot_events
        # mpim:history is the scope message.mpim requires (per Slack docs);
        # mpim:read mirrors im:read for conversations.info classification.
        assert "mpim:history" in bot_scopes
        assert "mpim:read" in bot_scopes

    def test_group_dm_surface_present_without_assistant_mode(self):
        """Dropping assistant mode must not strip the group-DM surface."""
        manifest = _build_full_manifest(
            "Alice", "Your Alice Agent on Slack", include_assistant=False
        )

        bot_scopes = manifest["oauth_config"]["scopes"]["bot"]
        bot_events = manifest["settings"]["event_subscriptions"]["bot_events"]
        assert "message.mpim" in bot_events
        assert "mpim:history" in bot_scopes

    def test_assistant_features_remain_enabled(self):
        manifest = _build_full_manifest("Alice", "Your Alice Agent on Slack")

        assert "assistant_view" in manifest["features"]
        assert "assistant:write" in manifest["oauth_config"]["scopes"]["bot"]
        bot_events = manifest["settings"]["event_subscriptions"]["bot_events"]
        assert "assistant_thread_started" in bot_events

    def test_no_assistant_omits_assistant_pieces(self):
        manifest = _build_full_manifest(
            "Alice", "Your Alice Agent on Slack", include_assistant=False
        )

        # assistant_view feature is gone -> Slack renders a flat DM, not the
        # Assistant thread pane (where bare slash commands don't dispatch).
        assert "assistant_view" not in manifest["features"]
        assert "assistant:write" not in manifest["oauth_config"]["scopes"]["bot"]
        bot_events = manifest["settings"]["event_subscriptions"]["bot_events"]
        assert "assistant_thread_started" not in bot_events
        assert "assistant_thread_context_changed" not in bot_events

    def test_no_assistant_preserves_core_surface(self):
        """Dropping assistant mode must NOT strip the regular messaging surface."""
        manifest = _build_full_manifest(
            "Alice", "Your Alice Agent on Slack", include_assistant=False
        )

        # Flat DM still needs the Messages tab writable.
        assert manifest["features"]["app_home"]["messages_tab_enabled"] is True
        # Slash commands and Socket Mode are independent of assistant mode.
        assert manifest["features"]["slash_commands"]
        assert manifest["settings"]["socket_mode_enabled"] is True
        # Channel + DM scopes/events survive so the bot still works everywhere.
        bot_scopes = manifest["oauth_config"]["scopes"]["bot"]
        for scope in ("commands", "channels:history", "groups:read", "im:history"):
            assert scope in bot_scopes
        bot_events = manifest["settings"]["event_subscriptions"]["bot_events"]
        for event in ("message.im", "message.channels", "message.groups", "app_mention"):
            assert event in bot_events


class TestSlackWorkspaceArgparse:
    """The workspace subcommands (auth/channels/read/post/search) parse real argv."""

    def test_read_parses_channel_and_limit(self):
        args = _parse_slack_args(["slack", "read", "#general", "--limit", "5"])
        assert args.slack_command == "read"
        assert args.channel == "#general"
        assert args.limit == 5

    def test_post_parses_thread_reply(self):
        args = _parse_slack_args(
            ["slack", "post", "C0123456789", "hola", "--thread", "1700000000.000100"]
        )
        assert args.slack_command == "post"
        assert args.text == "hola"
        assert args.thread == "1700000000.000100"

    def test_search_collects_multiword_query(self):
        args = _parse_slack_args(["slack", "search", "bug", "login", "flow"])
        assert args.query == ["bug", "login", "flow"]

    def test_probe_and_private_flags_default_false(self):
        assert _parse_slack_args(["slack", "auth"]).probe is False
        assert _parse_slack_args(["slack", "channels"]).private is False


class TestSlackWorkspaceCommands:
    """Command behavior against a faked Slack API (no network)."""

    def test_resolve_channel_passes_ids_through_without_network(self, monkeypatch):
        from alice_cli import slack_cli

        def _boom(*_a, **_k):  # pragma: no cover - guard
            raise AssertionError("no API call expected for an ID")

        monkeypatch.setattr(slack_cli, "_slack_api", _boom)
        assert slack_cli._resolve_channel("xoxb-fake", "C0123456789") == "C0123456789"

    def test_resolve_channel_looks_up_by_name(self, monkeypatch):
        from alice_cli import slack_cli

        monkeypatch.setattr(
            slack_cli,
            "_slack_api",
            lambda *_a, **_k: {
                "ok": True,
                "channels": [{"id": "C0ABC", "name": "general"}],
            },
        )
        assert slack_cli._resolve_channel("xoxb-fake", "#general") == "C0ABC"

    def test_auth_prints_identity_and_returns_zero(self, monkeypatch, capsys):
        from types import SimpleNamespace

        from alice_cli import slack_cli

        monkeypatch.setattr(slack_cli, "_get_slack_token", lambda kind="bot": "xoxb-fake")
        monkeypatch.setattr(
            slack_cli,
            "_slack_api",
            lambda *_a, **_k: {
                "ok": True,
                "team": "Acme",
                "user": "bot",
                "user_id": "U1",
                "bot_id": "B1",
            },
        )
        rc = slack_cli.slack_auth_command(SimpleNamespace(probe=False))
        out = capsys.readouterr().out
        assert rc == 0
        assert "equipo=Acme" in out and "bot_id=B1" in out
        # identity only — the token itself must never leak into output
        assert "xoxb-fake" not in out

    def test_missing_scope_error_names_the_needed_scope(self, capsys):
        from alice_cli.slack_cli import _SlackApiError, _print_api_error

        rc = _print_api_error(
            _SlackApiError(
                "conversations.list",
                {"ok": False, "error": "missing_scope",
                 "needed": "channels:read", "provided": "users:read"},
            )
        )
        err = capsys.readouterr().err
        assert rc == 1
        assert "channels:read" in err and "OAuth" in err

    def test_post_retries_with_resolved_channel_on_unknown_id(self, monkeypatch, capsys):
        from types import SimpleNamespace

        from alice_cli import slack_cli

        calls = []

        def fake_api(method, token, **params):
            calls.append((method, params.get("channel")))
            if method == "chat.postMessage" and params.get("channel") == "#general":
                return {"ok": False, "error": "channel_not_found"}
            if method == "conversations.list":
                return {"ok": True, "channels": [{"id": "C0ABC", "name": "general"}]}
            return {"ok": True, "ts": "1700000000.000100", "channel": params.get("channel")}

        monkeypatch.setattr(slack_cli, "_get_slack_token", lambda kind="bot": "xoxb-fake")
        monkeypatch.setattr(slack_cli, "_slack_api", fake_api)
        rc = slack_cli.slack_post_command(
            SimpleNamespace(channel="#general", text="hola", thread=None, json=False)
        )
        assert rc == 0
        # first attempt used the raw name, retry used the resolved ID
        assert calls[0][1] == "#general"
        assert ("chat.postMessage", "C0ABC") in calls
        assert "ok ts=" in capsys.readouterr().out
