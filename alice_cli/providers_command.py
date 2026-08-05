"""``alice providers`` command handler (kept out of main.py)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Optional

from alice_cli import provider_registry as pr


def _ask_yes_no(prompt: str) -> bool:
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in {"y", "yes"}
    except (EOFError, KeyboardInterrupt):
        return False


def _print_list_json() -> None:
    from alice_cli.provider_catalog import provider_catalog

    rows = []
    for d in provider_catalog():
        rows.append(
            {
                "id": d.slug,
                "label": d.label,
                "auth_type": d.auth_type,
                "tab": d.tab,
                "custom": d.slug.startswith("custom:"),
            }
        )
    print(json.dumps(rows, indent=2))


def _print_list_human() -> None:
    from alice_cli.provider_catalog import provider_catalog

    builtins, customs = [], []
    for d in provider_catalog():
        (customs if d.slug.startswith("custom:") else builtins).append(d)

    print("Built-in providers:")
    for d in builtins:
        print(f"  {d.slug:<24} {d.label}  [{d.auth_type}]")
    print("\nCustom providers (~/.alice/providers.d/):")
    if not customs:
        print("  (none — add one with: alice providers add <file.yaml>)")
    for d in customs:
        print(f"  {d.slug:<24} {d.label}  [{d.auth_type}]")


def _spec_from_args(args) -> Optional[dict[str, Any]]:
    """Build a DPR spec from CLI flags (inline mode)."""
    if not args.name or not args.base_url:
        print("error: inline mode needs both --name and --base-url (or pass a YAML file)", file=sys.stderr)
        return None
    spec: dict[str, Any] = {"name": args.name, "base_url": args.base_url}
    if args.api_key_env:
        spec["api_key_env"] = args.api_key_env
    if args.api_mode:
        spec["api_mode"] = args.api_mode
    if args.model:
        spec["models"] = list(args.model)
    return spec


def _cmd_add(args) -> int:
    if args.file:
        try:
            spec = pr.import_spec_file(Path(args.file))
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    else:
        spec = _spec_from_args(args)
        if spec is None:
            return 1
        try:
            spec = pr.validate_spec(spec)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    try:
        entry = pr.add_custom_provider(spec)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    cid = pr.normalize_id(str(entry["name"]))
    print(f"registered custom provider '{cid}' -> {entry.get('base_url')}")
    print("it now appears in: alice model, desktop Settings → Providers")
    return 0


def _cmd_test(args) -> int:
    try:
        result = pr.test_provider(args.id)
    except KeyError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if result.get("ok"):
        models = result.get("models") or []
        model_list = ", ".join(models[:10]) + ("…" if len(models) > 10 else "")
        print(f"ok — {result.get('latency_ms')}ms" + (f", {len(models)} models ({model_list})" if models else ""))
        return 0
    print(f"failed — {result.get('error')}", file=sys.stderr)
    return 1


def _cmd_remove(args) -> int:
    if not args.yes and not _ask_yes_no(f"remove custom provider '{args.id}'? "):
        print("aborted")
        return 1
    if pr.remove_custom_provider(args.id):
        print(f"removed '{args.id}'")
        return 0
    print(f"error: custom provider '{args.id}' not found", file=sys.stderr)
    return 1


def providers_command(args) -> int:
    action = getattr(args, "providers_action", None) or getattr(args, "providers_fn", "list")
    if action == "list":
        if getattr(args, "json", False):
            _print_list_json()
        else:
            _print_list_human()
        return 0
    if action == "add":
        return _cmd_add(args)
    if action == "test":
        return _cmd_test(args)
    if action == "remove":
        return _cmd_remove(args)
    _print_list_human()
    return 0
