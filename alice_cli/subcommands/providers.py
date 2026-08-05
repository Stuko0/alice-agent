"""``alice providers`` subcommand parser.

Declarative custom-provider management (Dynamic Provider Registry):
``providers.d/*.yaml`` → validated → ``config.providers`` + credential pool.
Handler injected to avoid importing ``main``.
"""

from __future__ import annotations

from typing import Callable


def build_providers_parser(subparsers, *, cmd_providers: Callable) -> None:
    """Attach the ``providers`` subcommand to ``subparsers``."""
    providers_parser = subparsers.add_parser(
        "providers",
        help="Manage custom AI providers",
        description=(
            "List, add, test and remove custom providers (Dynamic Provider "
            "Registry). Custom providers live as small YAML files in "
            "~/.alice/providers.d/ and appear everywhere the built-in "
            "providers do — `alice model`, desktop Settings → Providers."
        ),
    )
    providers_sub = providers_parser.add_subparsers(dest="providers_action")

    # providers list
    p_list = providers_sub.add_parser("list", help="List all providers (built-in + custom)")
    p_list.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    p_list.set_defaults(providers_fn="list")

    # providers add <file.yaml|--name --base-url ...>
    p_add = providers_sub.add_parser(
        "add",
        help="Register a custom provider",
        description=(
            "Accepts a DPR YAML/JSON file or inline --name/--base-url flags. "
            "Validates the spec and writes it to config.providers."
        ),
    )
    p_add.add_argument("file", nargs="?", help="Path to a providers.d YAML/JSON file")
    p_add.add_argument("--name", help="Provider display name (inline mode)")
    p_add.add_argument("--base-url", help="Provider base URL, e.g. https://api.example.com/v1")
    p_add.add_argument("--api-key-env", help="Env var holding the API key (optional)")
    p_add.add_argument("--api-mode", choices=["openai", "anthropic"], help="API dialect (default: openai)")
    p_add.add_argument("--model", action="append", help="Model id to pin (repeatable; optional)")
    p_add.set_defaults(providers_fn="add")

    # providers test <id>
    p_test = providers_sub.add_parser(
        "test", help="Probe a custom provider endpoint (GET /models)",
    )
    p_test.add_argument("id", help="Custom provider id (the slugified name)")
    p_test.set_defaults(providers_fn="test")

    # providers remove <id>
    p_remove = providers_sub.add_parser("remove", aliases=["rm"], help="Remove a custom provider")
    p_remove.add_argument("id", help="Custom provider id")
    p_remove.add_argument("--yes", "-y", action="store_true", help="Skip confirmation")
    p_remove.set_defaults(providers_fn="remove")

    providers_parser.set_defaults(func=cmd_providers)
