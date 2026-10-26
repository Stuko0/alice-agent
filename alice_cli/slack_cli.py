"""``alice slack ...`` CLI subcommands.

Today only ``alice slack manifest`` is implemented — it generates the
Slack app manifest JSON for registering every gateway command as a native
Slack slash (``/btw``, ``/stop``, ``/model``, …) so users get the same
first-class slash UX Discord and Telegram already have.

Typical workflow::

    $ alice slack manifest > slack-manifest.json
    # or:
    $ alice slack manifest --write

Then paste the printed JSON into the Slack app config (Features → App
Manifest → Edit) and click Save. Slack diffs the manifest and prompts
for reinstall when scopes/commands change.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _build_full_manifest(
    bot_name: str,
    bot_description: str,
    include_assistant: bool = True,
) -> dict:
    """Build a full Slack manifest merging display info + our slash list.

    The slash-command list is always generated from ``COMMAND_REGISTRY`` so
    it stays in sync with the rest of Alice. Other manifest sections
    (display info, OAuth scopes, socket mode) are set to sensible defaults
    for a Alice deployment — users can tweak them in the Slack UI after
    pasting.

    When ``include_assistant`` is True (default) the manifest opts the app
    into Slack's AI Assistant container: the ``assistant_view`` feature, the
    ``assistant:write`` scope, and the ``assistant_thread_*`` events. Slack
    then renders DMs as the right-hand Assistant split-pane, where every
    exchange is a thread and bare slash commands are not delivered as normal
    ``command`` events. Pass ``include_assistant=False`` (``--no-assistant``)
    to omit those three pieces and get a flat DM surface where ``/help``,
    ``/new``, etc. work inline.
    """
    from alice_cli.commands import slack_app_manifest

    partial = slack_app_manifest()
    slashes = partial["features"]["slash_commands"]

    features = {
        "app_home": {
            "home_tab_enabled": False,
            "messages_tab_enabled": True,
            "messages_tab_read_only_enabled": False,
        },
        "bot_user": {
            "display_name": bot_name[:80],
            "always_online": True,
        },
        "slash_commands": slashes,
    }

    bot_scopes = [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "users:read",
    ]

    bot_events = [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
    ]

    if include_assistant:
        features["assistant_view"] = {
            "assistant_description": "Chat with Alice in threads and DMs.",
        }
        bot_scopes.append("assistant:write")
        bot_events.extend(
            [
                "assistant_thread_context_changed",
                "assistant_thread_started",
            ]
        )
        bot_scopes.sort()
        bot_events.sort()

    return {
        "_metadata": {
            "major_version": 1,
            "minor_version": 1,
        },
        "display_information": {
            "name": bot_name[:35],
            "description": (bot_description or "Your Alice Agent on Slack")[:140],
            "background_color": "#2a273f",
        },
        "features": features,
        "oauth_config": {
            "scopes": {
                "bot": bot_scopes,
            },
        },
        "settings": {
            "event_subscriptions": {
                "bot_events": bot_events,
            },
            "interactivity": {
                "is_enabled": True,
            },
            "org_deploy_enabled": False,
            "socket_mode_enabled": True,
            "token_rotation_enabled": False,
        },
    }


def slack_manifest_command(args) -> int:
    """Print or write a Slack app manifest JSON.

    Flags (all parsed in ``alice_cli/main.py``):
      --write [PATH]  Write to file instead of stdout (default path:
                      ``$ALICE_HOME/slack-manifest.json``)
      --name NAME     Override the bot display name (default: "Alice")
      --description DESC  Override the bot description
      --slashes-only  Emit only the ``features.slash_commands`` array (for
                      merging into an existing manifest manually)
      --no-assistant  Omit Slack AI Assistant mode (assistant_view feature,
                      assistant:write scope, assistant_thread_* events) so
                      DMs render as a flat chat where bare slash commands
                      work inline instead of the Assistant thread pane.
    """
    name = getattr(args, "name", None) or "Alice"
    description = getattr(args, "description", None) or "Your Alice Agent on Slack"
    include_assistant = not getattr(args, "no_assistant", False)

    if getattr(args, "slashes_only", False):
        from alice_cli.commands import slack_app_manifest

        manifest = slack_app_manifest()["features"]["slash_commands"]
    else:
        manifest = _build_full_manifest(name, description, include_assistant=include_assistant)

    payload = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

    write_target = getattr(args, "write", None)
    if write_target is not None:
        if isinstance(write_target, bool) and write_target:
            # --write with no value → default location
            try:
                from alice_constants import get_alice_home

                target = Path(get_alice_home()) / "slack-manifest.json"
            except Exception:
                target = Path(os.environ.get("ALICE_HOME") or str(Path.home() / ".alice")) / "slack-manifest.json"
        else:
            target = Path(write_target).expanduser()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(payload, encoding="utf-8")
        print(f"Slack manifest written to: {target}", file=sys.stderr)
        print(
            "\nNext steps:\n"
            "  1. Open https://api.slack.com/apps and pick your Alice app\n"
            "     (or create a new one: Create New App → From an app manifest).\n"
            f"  2. Features → App Manifest → paste the contents of\n"
            f"     {target}\n"
            "  3. Save; Slack will prompt to reinstall the app if scopes or\n"
            "     slash commands changed.\n"
            "  4. Make sure Socket Mode is enabled and you have a bot token\n"
            "     (xoxb-...) and app token (xapp-...) configured via\n"
            "     `alice setup`.\n",
            file=sys.stderr,
        )
    else:
        sys.stdout.write(payload)
    return 0


# ---------------------------------------------------------------------------
# Workspace commands: alice slack auth|channels|read|post|search
#
# Thin, dependency-free (stdlib urllib) wrappers over the Slack Web API so
# the agent — and scripts — can read/manage a workspace without going
# through the gateway. Tokens are read from .env; they are never printed.
# ---------------------------------------------------------------------------

_AUTH_HEADER = "Authorization"  # kept as a name so the value stays out of literals


class _SlackApiError(Exception):
    def __init__(self, method: str, data: dict):
        super().__init__(f"{method}: {data.get('error')}")
        self.method = method
        self.data = data


def _get_slack_token(kind: str = "bot") -> str:
    """Return a Slack token from .env ('bot' → SLACK_BOT_TOKEN, 'user' → SLACK_USER_TOKEN)."""
    key = "SLACK_BOT_TOKEN" if kind == "bot" else "SLACK_USER_TOKEN"
    token = ""
    try:
        from alice_cli.config import get_env_value

        token = (get_env_value(key) or "").strip()
    except Exception:
        token = ""
    if not token:
        token = (os.environ.get(key) or "").strip()
    if not token:
        print(
            f"{key} no está definido. Agréguelo en `alice config env-path` "
            f"(`{key}=...)` y vuelva a intentarlo.",
            file=sys.stderr,
        )
    return token


def _slack_api(method: str, token: str, **params) -> dict:
    """POST a Slack Web API method. Returns the decoded JSON body (never raises)."""
    import urllib.parse
    import urllib.request

    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=data,
        headers={_AUTH_HEADER: "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # network / HTTP errors → same shape as Slack errors
        return {"ok": False, "error": f"http_error: {exc}"}


def _raise_for(method: str, data: dict) -> None:
    if data.get("ok"):
        return
    raise _SlackApiError(method, data)


def _print_api_error(err: _SlackApiError) -> int:
    data = err.data
    code = data.get("error", "unknown_error")
    print(f"Slack {err.method} falló: {code}", file=sys.stderr)
    if code == "missing_scope":
        print(f"  needed:    {data.get('needed', '?')}", file=sys.stderr)
        print(f"  provided:  {data.get('provided', '?')}", file=sys.stderr)
        print(
            "  Agregue los scopes en https://api.slack.com/apps → tu app →\n"
            "  Features → OAuth & Permissions → Bot Token Scopes y reinstale\n"
            "  la app (Install App → Reinstall to Workspace).",
            file=sys.stderr,
        )
    elif code in {"invalid_auth", "not_authed", "token_revoked", "account_inactive"}:
        print(
            "  Revise SLACK_BOT_TOKEN en `alice config env-path` "
            "y regenere el token si expiró.",
            file=sys.stderr,
        )
    elif code in {"channel_not_found", "not_in_channel"}:
        print(
            "  El bot debe estar invitado al canal: /invite @<nombre-del-bot> "
            "desde Slack.",
            file=sys.stderr,
        )
    return 1


def _resolve_channel(token: str, ref: str) -> str:
    """Accept a channel ID (C…/G…/D…) or a name ('general' / '#general').

    Falls back to conversations.list, which needs the `channels:read` scope.
    """
    ref = (ref or "").strip()
    if ref[:1] in {"C", "G", "D"} and len(ref) >= 9:
        return ref
    name = ref[1:] if ref.startswith("#") else ref
    cursor = ""
    while True:
        params = {"types": "public_channel,private_channel", "limit": "200", "exclude_archived": "true"}
        if cursor:
            params["cursor"] = cursor
        data = _slack_api("conversations.list", token, **params)
        _raise_for("conversations.list", data)
        for ch in data.get("channels", []):
            if ch.get("name") == name:
                return ch["id"]
        cursor = (data.get("response_metadata") or {}).get("next_cursor") or ""
        if not cursor:
            break
    raise _SlackApiError(
        "conversations.list",
        {"ok": False, "error": "channel_not_found", "channel": ref},
    )


def slack_auth_command(args) -> int:
    """Verify configured Slack tokens (identity only — values are never printed)."""
    probe = getattr(args, "probe", False)
    for kind in ("bot", "user"):
        label = "bot" if kind == "bot" else "user"
        key = "SLACK_BOT_TOKEN" if kind == "bot" else "SLACK_USER_TOKEN"
        token = _get_slack_token(kind)
        if not token:
            print(f"{label:4}  ({key}: no definido)")
            continue
        data = _slack_api("auth.test", token)
        if not data.get("ok"):
            print(f"{label:4}  ERROR {data.get('error')}")
            continue
        expiry = data.get("expires_in")
        extra = f", expira en {int(expiry) // 3600} h" if expiry else ""
        bot = data.get("bot_id")
        print(
            f"{label:4}  equipo={data.get('team')} usuario={data.get('user')} "
            f"id={data.get('user_id')}{' bot_id=' + bot if bot else ''}{extra}"
        )

    if probe:
        token = _get_slack_token("bot")
        if not token:
            return 1
        status = 0
        for method, params in (
            ("conversations.list", {"types": "public_channel", "limit": "1"}),
            ("users.list", {"limit": "1"}),
        ):
            data = _slack_api(method, token, **params)
            if data.get("ok"):
                print(f"probe  {method}: OK")
            else:
                print(f"probe  {method}: {data.get('error')} (needed: {data.get('needed', '-')})")
                status = 1
        return status
    return 0


def slack_channels_command(args) -> int:
    """List channels the bot can see (needs `channels:read`)."""
    token = _get_slack_token("bot")
    if not token:
        return 1
    types = "public_channel,private_channel" if getattr(args, "private", False) else "public_channel"
    channels, cursor = [], ""
    try:
        while True:
            params = {"types": types, "limit": "200", "exclude_archived": "true"}
            if cursor:
                params["cursor"] = cursor
            data = _slack_api("conversations.list", token, **params)
            _raise_for("conversations.list", data)
            channels.extend(data.get("channels", []))
            cursor = (data.get("response_metadata") or {}).get("next_cursor") or ""
            if not cursor:
                break
    except _SlackApiError as err:
        return _print_api_error(err)

    if getattr(args, "json", False):
        print(json.dumps(channels, indent=2, ensure_ascii=False))
        return 0
    for ch in channels:
        topic = ((ch.get("topic") or {}).get("value") or "").replace("\n", " ")
        member = "join" if ch.get("is_member") else "----"
        print(f"{ch['id']}  {member}  #{ch['name']}" + (f"  | {topic[:60]}" if topic else ""))
    print(f"\n{len(channels)} canal(es). 'join' = el bot ya está invitado.", file=sys.stderr)
    return 0


def slack_read_command(args) -> int:
    """Read the latest messages of a channel (bot must be a member)."""
    token = _get_slack_token("bot")
    if not token:
        return 1
    try:
        channel = _resolve_channel(token, args.channel)
        data = _slack_api(
            "conversations.history",
            token,
            channel=channel,
            limit=str(getattr(args, "limit", 20) or 20),
        )
        _raise_for("conversations.history", data)
    except _SlackApiError as err:
        return _print_api_error(err)

    messages = data.get("messages", [])
    if getattr(args, "json", False):
        print(json.dumps(messages, indent=2, ensure_ascii=False))
        return 0
    for msg in reversed(messages):
        text = (msg.get("text") or "").replace("\n", " ⏎ ")
        replies = msg.get("reply_count") or 0
        thread = f"  [replies={replies}]" if replies else ""
        who = msg.get("user") or msg.get("bot_id") or "?"
        print(f"{msg.get('ts')}  {who}  {text[:300]}{thread}")
        if msg.get("files"):
            print(f"    +{len(msg['files'])} archivo(s)")
    print(f"\n{len(messages)} mensaje(s) de {args.channel}", file=sys.stderr)
    return 0


def slack_post_command(args) -> int:
    """Post a message to a channel (optionally as a thread reply)."""
    token = _get_slack_token("bot")
    if not token:
        return 1
    params = {"channel": args.channel, "text": args.text}
    if getattr(args, "thread", None):
        params["thread_ts"] = args.thread
    data = _slack_api("chat.postMessage", token, **params)
    if not data.get("ok"):
        # name → id fallback (keeps `alice slack post #general ...` working)
        if data.get("error") in {"channel_not_found", "invalid_channel"}:
            try:
                channel = _resolve_channel(token, args.channel)
                params["channel"] = channel
                data = _slack_api("chat.postMessage", token, **params)
            except _SlackApiError as err:
                return _print_api_error(err)
        if not data.get("ok"):
            return _print_api_error(_SlackApiError("chat.postMessage", data))
    if getattr(args, "json", False):
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print(f"ok ts={data.get('ts')} channel={data.get('channel')}")
    return 0


def slack_search_command(args) -> int:
    """Full-text search across the workspace (needs `search:read` on the token)."""
    token = _get_slack_token("bot")
    if not token:
        return 1
    query = " ".join(args.query)
    data = _slack_api(
        "search.messages",
        token,
        query=query,
        count=str(getattr(args, "count", 20) or 20),
    )
    if not data.get("ok"):
        # user tokens often carry search even when the bot does not
        user_token = _get_slack_token("user")
        if user_token:
            data = _slack_api(
                "search.messages", user_token, query=query,
                count=str(getattr(args, "count", 20) or 20),
            )
        if not data.get("ok"):
            return _print_api_error(_SlackApiError("search.messages", data))

    matches = (data.get("matches") or [])
    if getattr(args, "json", False):
        print(json.dumps(matches, indent=2, ensure_ascii=False))
        return 0
    for m in matches:
        channel = (m.get("channel") or {}).get("name", "?")
        text = (m.get("text") or "").replace("\n", " ")
        print(f"{m.get('ts')}  #{channel}  {text[:300]}")
    print(f"\n{len(matches)} resultado(s) para: {query}", file=sys.stderr)
    return 0
