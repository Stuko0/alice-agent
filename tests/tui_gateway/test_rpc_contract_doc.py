"""The JSON-RPC contract doc must match the live method registry.

`docs/protocol/json-rpc.md` is what a non-Python backend (the Go host/engine)
implements against. If a method is added, renamed or removed without updating
the doc, this fails — that is the point: two sources of truth drift silently
otherwise.
"""

from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

DOC = Path(__file__).resolve().parents[2] / "docs" / "protocol" / "json-rpc.md"
BEGIN = "<!-- BEGIN METHOD CATALOG -->"
END = "<!-- END METHOD CATALOG -->"
ROW = re.compile(r"^\|\s*`([a-z0-9_.]+)`\s*\|", re.MULTILINE)


@pytest.fixture(scope="module")
def registry() -> set[str]:
    """Import the gateway with the same stubs the protocol tests use."""
    with patch.dict(
        "sys.modules",
        {
            "alice_constants": MagicMock(
                get_alice_home=MagicMock(return_value="/tmp/alice_test")
            ),
            "alice_cli.env_loader": MagicMock(),
            "alice_cli.banner": MagicMock(),
            "alice_state": MagicMock(),
        },
    ):
        import importlib

        mod = importlib.import_module("tui_gateway.server")
        return set(mod._methods)


def _catalog_rows() -> list[str]:
    text = DOC.read_text(encoding="utf-8")
    assert BEGIN in text and END in text, "method catalog markers missing"
    section = text.split(BEGIN, 1)[1].split(END, 1)[0]
    return ROW.findall(section)


def test_catalog_matches_registry(registry: set[str]) -> None:
    documented = set(_catalog_rows())

    missing = sorted(registry - documented)
    stale = sorted(documented - registry)

    assert not missing and not stale, (
        "docs/protocol/json-rpc.md is out of sync with tui_gateway.server._methods\n"
        f"  undocumented methods: {missing}\n"
        f"  documented but not registered: {stale}"
    )


def test_catalog_has_no_duplicate_rows() -> None:
    rows = _catalog_rows()
    duplicates = sorted({name for name in rows if rows.count(name) > 1})
    assert not duplicates, f"duplicate rows in the method catalog: {duplicates}"
