"""``alice help`` subcommand parser — task-scoped help.

``alice help`` lists every indexed task; ``alice help <task>`` prints the
matching doc page (same index the desktop Help panel uses).
"""

from __future__ import annotations

from typing import Callable


def build_help_parser(subparsers, *, cmd_help: Callable) -> None:
    """Attach the ``help`` subcommand to ``subparsers``."""
    help_parser = subparsers.add_parser(
        "help",
        help="Show task-scoped help (same index as the desktop Help panel)",
        description=(
            "List help topics, or print the doc page for one: "
            "alice help <topic>. Topics include add-provider, first-run, "
            "backup, sessions, telegram, update, …"
        ),
    )
    help_parser.add_argument("topic", nargs="?", help="Help topic id (see 'alice help' for the list)")
    help_parser.set_defaults(func=cmd_help)
