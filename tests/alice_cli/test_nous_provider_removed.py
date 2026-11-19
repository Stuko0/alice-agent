"""Regression guard: the Nous Portal model provider is removed.

The desktop/CLI identify as Alice, not as a Nous product. The provider used to
be a first-class LLM backend (OAuth device login, curated catalog, model
picker row). These tests pin the removal as a contract: no registry entry, no
catalog row, no OAuth card, and no picker row even when a stale auth store
still carries Nous credentials.
"""

from __future__ import annotations

import json


def test_nous_absent_from_auth_registry():
    from alice_cli.auth import PROVIDER_REGISTRY

    assert "nous" not in PROVIDER_REGISTRY


def test_nous_absent_from_catalog_and_overlays():
    from alice_cli.models import _PROVIDER_MODELS
    from alice_cli.providers import ALICE_OVERLAYS, get_provider

    assert "nous" not in ALICE_OVERLAYS
    assert "nous" not in _PROVIDER_MODELS
    assert get_provider("nous") is None


def test_nous_absent_from_oauth_provider_catalog():
    from alice_cli.web_server import _OAUTH_PROVIDER_CATALOG

    assert "nous" not in {entry["id"] for entry in _OAUTH_PROVIDER_CATALOG}


def test_nous_absent_from_picker_even_with_stale_auth():
    """A leftover ``providers.nous`` entry must not resurrect a picker row."""
    from alice_constants import get_alice_home

    (get_alice_home() / "auth.json").write_text(
        json.dumps(
            {
                "providers": {"nous": {"access_token": "stale-token"}},
                "credential_pool": {"nous": [{"access_token": "stale-token"}]},
                "active_provider": "nous",
            }
        ),
        encoding="utf-8",
    )

    from alice_cli.model_switch import list_authenticated_providers

    rows = list_authenticated_providers(current_provider="nous", max_models=99)

    assert "nous" not in {str(row.get("slug", "")).lower() for row in rows}


def test_nous_cannot_be_added_via_auth_cli():
    """`alice auth add nous` is rejected as an unknown provider."""
    import argparse

    import pytest

    from alice_cli.auth_commands import auth_add_command

    args = argparse.Namespace(provider="nous", auth_type="", api_key="x", label=None)
    with pytest.raises(SystemExit):
        auth_add_command(args)
