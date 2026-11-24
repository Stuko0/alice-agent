#!/usr/bin/env python3
"""Regenerate go/internal/config/schema.json from the Python config module.

The Go host embeds a snapshot of DEFAULT_CONFIG and the optional env-var
metadata so `alice config check` / `config dump` can work without importing
Python. Run this after changing DEFAULT_CONFIG or OPTIONAL_ENV_VARS:

    python scripts/gen_go_config_schema.py

`go test ./internal/config -run SchemaFreshness` (opt-in) fails when the
snapshot is stale.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from alice_cli.config import (  # noqa: E402
    _EXTRA_ENV_KEYS,
    DEFAULT_CONFIG,
    OPTIONAL_ENV_VARS,
)


def build_payload() -> dict:
    optional = []
    for name, info in OPTIONAL_ENV_VARS.items():
        optional.append(
            {
                "name": name,
                "description": info.get("description", ""),
                "tools": list(info.get("tools") or []),
                "advanced": bool(info.get("advanced", False)),
                "category": info.get("category", ""),
            }
        )

    return {
        "config_version": int(DEFAULT_CONFIG.get("_config_version", 1)),
        "defaults": DEFAULT_CONFIG,
        "optional_env": optional,
        "extra_env_keys": sorted(_EXTRA_ENV_KEYS),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdout", action="store_true", help="print instead of writing")
    args = parser.parse_args()

    payload = build_payload()
    data = json.dumps(payload, indent=2, sort_keys=False) + "\n"
    if args.stdout:
        sys.stdout.write(data)
        return 0

    out = ROOT / "go" / "internal" / "config" / "schema.json"
    out.write_text(data, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(payload['optional_env'])} env vars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
