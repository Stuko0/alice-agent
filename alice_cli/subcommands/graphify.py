"""``alice graphify`` subcommand parser."""

from __future__ import annotations

from typing import Callable


def build_graphify_parser(subparsers, *, cmd_graphify: Callable) -> None:
    """Attach the ``graphify`` subcommand to ``subparsers``."""
    # =========================================================================
    # graphify command
    # =========================================================================
    graphify_parser = subparsers.add_parser(
        "graphify",
        help="Analyze the project with graphify",
        description="Run graphify extract to analyze the codebase and generate GRAPH_REPORT.md.",
    )
    graphify_parser.add_argument(
        "--deep", action="store_true", help="Use deep mode (semantic re-extraction)"
    )
    graphify_parser.set_defaults(func=cmd_graphify)
