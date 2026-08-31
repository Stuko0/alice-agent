"""Tests for agent.portal_tags — Nous Portal request tag contract."""

from __future__ import annotations


def test_alice_client_tag_includes_current_version():
    """The client tag must reflect alice_cli.__version__ verbatim."""
    from alice_cli import __version__
    from agent.portal_tags import alice_client_tag

    assert alice_client_tag() == f"client=alice-client-v{__version__}"


def test_alice_client_tag_format():
    """The client tag has the exact shape Nous Portal expects."""
    from agent.portal_tags import alice_client_tag

    tag = alice_client_tag()
    assert tag.startswith("client=alice-client-v")
    # No spaces, no commas — single tag value
    assert " " not in tag
    assert "," not in tag


def test_nous_portal_tags_contains_product_and_client():
    """Every Nous Portal request gets BOTH the product tag and the version tag."""
    from agent.portal_tags import alice_client_tag, nous_portal_tags

    tags = nous_portal_tags()
    assert "product=alice-agent" in tags
    assert alice_client_tag() in tags
    assert len(tags) == 2


def test_nous_portal_tags_returns_fresh_list():
    """Callers mutate the returned list; we must not share state across calls."""
    from agent.portal_tags import nous_portal_tags

    a = nous_portal_tags()
    a.append("client=test-mutation")
    b = nous_portal_tags()
    assert "client=test-mutation" not in b


def test_auxiliary_client_nous_extra_body_uses_helper():
    """auxiliary_client.NOUS_EXTRA_BODY must match the canonical helper output."""
    from agent.auxiliary_client import NOUS_EXTRA_BODY
    from agent.portal_tags import nous_portal_tags

    assert NOUS_EXTRA_BODY == {"tags": nous_portal_tags()}
