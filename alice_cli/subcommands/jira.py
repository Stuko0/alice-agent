"""``alice jira`` subcommand parser.

Mirrors the ``alice slack`` subcommand layout: a small parser factory
attached to the main ``subparsers`` tree in ``alice_cli/main.py``.
"""
from __future__ import annotations

from typing import Callable


def build_jira_parser(subparsers, *, cmd_jira: Callable) -> None:
    """Attach the ``jira`` subcommand to ``subparsers``."""
    jira_parser = subparsers.add_parser(
        "jira",
        help="Jira Cloud helpers (list/show tickets for the Purple Mango Corp project)",
        description="Read tickets from Jira Cloud. Credentials come from "
        "JIRA_BASE_URL / JIRA_API_TOKEN / JIRA_USER_EMAIL in .env; auth is "
        "Basic (email + token).",
    )
    jira_sub = jira_parser.add_subparsers(dest="jira_command")

    jira_auth = jira_sub.add_parser(
        "auth",
        help="Verify the configured Jira credentials (identity only, values never printed)",
        description="Run /rest/api/3/myself against the configured token and "
        "report the account. --probe additionally checks the search "
        "endpoint used by `alice jira list`.",
    )
    jira_auth.add_argument(
        "--probe",
        action="store_true",
        help="Also probe the issue-search endpoint and report failures",
    )

    jira_list = jira_sub.add_parser(
        "list",
        help="List issues (default: unresolved MM issues by priority)",
        description="List issues with JQL. Without --jql/--project it shows "
        "every unresolved issue of project MM ordered by priority.",
    )
    jira_list.add_argument("--jql", default=None, metavar="JQL",
                           help="Full JQL query (overrides --project)")
    jira_list.add_argument("--project", default=None, metavar="KEY",
                           help="Project key shortcut (default MM), unresolved only")
    jira_list.add_argument("--limit", type=int, default=50,
                           help="Max issues to fetch (default 50)")
    jira_list.add_argument("--json", action="store_true", help="Emit raw JSON")

    jira_show = jira_sub.add_parser(
        "show",
        help="Show one issue in detail (description, comments, subtasks, links)",
        description="Fetch a single issue by key, e.g. `alice jira show MM-58`.",
    )
    jira_show.add_argument("key", help="Issue key, e.g. MM-58")
    jira_show.add_argument("--json", action="store_true", help="Emit raw JSON")

    jira_parser.set_defaults(func=cmd_jira)
