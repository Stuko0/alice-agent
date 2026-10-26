"""``alice slack`` subcommand parser.

Extracted verbatim from ``alice_cli/main.py:main()`` (god-file Phase 2).
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

from typing import Callable


def build_slack_parser(subparsers, *, cmd_slack: Callable) -> None:
    """Attach the ``slack`` subcommand to ``subparsers``."""
    # =========================================================================
    # slack command
    # =========================================================================
    slack_parser = subparsers.add_parser(
        "slack",
        help="Slack integration helpers (manifest generation, etc.)",
        description="Slack integration helpers for Alice.",
    )
    slack_sub = slack_parser.add_subparsers(dest="slack_command")
    slack_manifest = slack_sub.add_parser(
        "manifest",
        help="Print or write a Slack app manifest with every gateway command "
        "registered as a native slash (/btw, /stop, /model, ...)",
        description=(
            "Generate a Slack app manifest that registers every gateway "
            "command in COMMAND_REGISTRY as a first-class Slack slash "
            "command (matching Discord and Telegram parity). Paste the "
            "output into Slack app config → Features → App Manifest → "
            "Edit, then Save. Reinstall the app if Slack prompts for it."
        ),
    )
    slack_manifest.add_argument(
        "--write",
        nargs="?",
        const=True,
        default=None,
        metavar="PATH",
        help="Write manifest to a file instead of stdout. With no PATH "
        "writes to $ALICE_HOME/slack-manifest.json.",
    )
    slack_manifest.add_argument(
        "--name",
        default=None,
        help='Bot display name (default: "Alice")',
    )
    slack_manifest.add_argument(
        "--description",
        default=None,
        help="Bot description shown in Slack's app directory.",
    )
    slack_manifest.add_argument(
        "--slashes-only",
        action="store_true",
        help="Emit only the features.slash_commands array (for merging "
        "into an existing manifest manually).",
    )
    slack_manifest.add_argument(
        "--no-assistant",
        action="store_true",
        help="Omit Slack AI Assistant mode (assistant_view, assistant:write "
        "scope, assistant_thread_* events). DMs then render as a flat chat "
        "where bare slash commands (/help, /new) work inline instead of "
        "Slack's Assistant thread pane.",
    )

    # ------------------------------------------------------------------
    # Workspace commands (auth / channels / read / post / search)
    # ------------------------------------------------------------------
    slack_auth = slack_sub.add_parser(
        "auth",
        help="Verify the configured Slack tokens (identity only, values are never printed)",
        description="Run auth.test against SLACK_BOT_TOKEN / SLACK_USER_TOKEN and "
        "report team, user and bot identity. --probe additionally checks "
        "whether the bot has the scopes the workspace commands need.",
    )
    slack_auth.add_argument(
        "--probe",
        action="store_true",
        help="Also probe conversations.list / users.list and report missing scopes",
    )

    slack_channels = slack_sub.add_parser(
        "channels",
        help="List channels the bot can see (needs the channels:read scope)",
        description="List public (and optionally private) channels with their IDs, "
        "a join flag showing whether the bot is already a member, and topic.",
    )
    slack_channels.add_argument(
        "--private", action="store_true", help="Include private channels the bot is in"
    )
    slack_channels.add_argument("--json", action="store_true", help="Emit raw JSON")

    slack_read = slack_sub.add_parser(
        "read",
        help="Read the latest messages of a channel (bot must be a member)",
        description="Read conversations.history for a channel given as an ID "
        "(C…/G…/D…) or as a name ('general' or '#general').",
    )
    slack_read.add_argument("channel", help="Channel ID or #name")
    slack_read.add_argument("--limit", type=int, default=20, help="Messages to fetch (default 20)")
    slack_read.add_argument("--json", action="store_true", help="Emit raw JSON")

    slack_post = slack_sub.add_parser(
        "post",
        help="Post a message to a channel (optionally inside a thread)",
        description="Post text with chat.postMessage. The channel may be an ID or a "
        "#name (resolved via conversations.list when needed).",
    )
    slack_post.add_argument("channel", help="Channel ID or #name")
    slack_post.add_argument("text", help="Message text")
    slack_post.add_argument("--thread", default=None, metavar="TS", help="thread_ts to reply inside a thread")
    slack_post.add_argument("--json", action="store_true", help="Emit raw JSON")

    slack_search = slack_sub.add_parser(
        "search",
        help="Full-text search across the workspace (needs the search:read scope)",
        description="Search messages with search.messages. Falls back to "
        "SLACK_USER_TOKEN when the bot token lacks the scope.",
    )
    slack_search.add_argument("query", nargs="+", help="Search query")
    slack_search.add_argument("--count", type=int, default=20, help="Max results (default 20)")
    slack_search.add_argument("--json", action="store_true", help="Emit raw JSON")

    slack_parser.set_defaults(func=cmd_slack)
