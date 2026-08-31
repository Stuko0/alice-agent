"""Unit tests for the Phase 2b terminal-billing core + HTTP client.

Covers:
- Decimal money parsing/formatting (server emits decimal strings, not 2dp).
- BillingState payload parsing (role tiering, presets, bounds, sub-structs).
- Error-code → typed-exception mapping (the live-verified contract matrix).
- Fail-open builder behavior.
- Idempotency key generation.
- Custom-amount validation against bounds + multipleOf 0.01.

No network: HTTP-layer tests drive _raise_for_error directly and monkeypatch the
request function for the builder.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

import agent.billing_view as bv
from agent.billing_view import (
    AutoReload,
    BillingState,
    CardInfo,
    MonthlyCap,
    billing_state_from_payload,
    build_billing_state,
    format_money,
    new_idempotency_key,
    parse_money,
    validate_charge_amount,
)
import alice_cli.nous_billing as nb


# ---------------------------------------------------------------------------
# Decimal money
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("142.5", Decimal("142.5")),   # decimal string, NOT 2dp — the headline case
        ("100", Decimal("100")),
        ("10000", Decimal("10000")),
        ("0.01", Decimal("0.01")),
        (250, Decimal("250")),
        ("  50  ", Decimal("50")),
    ],
)
def test_parse_money_valid(raw, expected):
    assert parse_money(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "abc", "1.2.3", "$5", {}])
def test_parse_money_invalid_returns_none(raw):
    assert parse_money(raw) is None


def test_parse_money_never_uses_binary_float():
    # If a float ever sneaks through, we still get an exact decimal, not 0.1+0.2 junk.
    assert parse_money(0.1) == Decimal("0.1")


@pytest.mark.parametrize(
    "value,expected",
    [
        (Decimal("142.5"), "$142.50"),
        (Decimal("100"), "$100"),
        (Decimal("0.01"), "$0.01"),
        (Decimal("1000"), "$1000"),
        (None, "—"),
    ],
)
def test_format_money(value, expected):
    assert format_money(value) == expected


# ---------------------------------------------------------------------------
# BillingState payload parsing
# ---------------------------------------------------------------------------


def _member_payload() -> dict:
    return {
        "org": {"id": "o1", "slug": "acme", "name": "Acme", "role": "MEMBER"},
        "balanceUsd": "142.5",
        "cliBillingEnabled": True,
        "chargePresets": ["100", "250", "500"],
        "bounds": {"minUsd": "10", "maxUsd": "10000"},
        "card": None,
        "monthlyCap": None,
        "autoReload": None,
    }


def _owner_payload() -> dict:
    p = _member_payload()
    p["org"]["role"] = "OWNER"
    p["card"] = {"brand": "visa", "last4": "4242"}
    p["monthlyCap"] = {
        "limitUsd": "1000",
        "spentThisMonthUsd": "180",
        "isDefaultCeiling": True,
    }
    p["autoReload"] = {"enabled": True, "thresholdUsd": "20", "reloadToUsd": "100"}
    return p


def test_state_member_tier_parse():
    s = billing_state_from_payload(_member_payload())
    assert s.logged_in
    assert s.role == "MEMBER"
    assert s.balance_usd == Decimal("142.5")
    assert s.cli_billing_enabled is True
    assert s.charge_presets == (Decimal("100"), Decimal("250"), Decimal("500"))
    assert s.min_usd == Decimal("10") and s.max_usd == Decimal("10000")
    assert s.card is None and s.monthly_cap is None and s.auto_reload is None
    assert s.is_admin is False
    assert s.can_charge is False  # not admin


def test_state_owner_tier_parse():
    s = billing_state_from_payload(_owner_payload())
    assert s.is_admin is True
    assert s.can_charge is True  # admin + kill-switch on
    assert s.card == CardInfo(brand="visa", last4="4242")
    assert s.card is not None and s.card.masked == "visa ····4242"
    assert s.monthly_cap == MonthlyCap(
        limit_usd=Decimal("1000"),
        spent_this_month_usd=Decimal("180"),
        is_default_ceiling=True,
    )
    assert s.auto_reload == AutoReload(
        enabled=True, threshold_usd=Decimal("20"), reload_to_usd=Decimal("100")
    )


def test_state_can_charge_false_when_killswitch_off():
    p = _owner_payload()
    p["cliBillingEnabled"] = False
    s = billing_state_from_payload(p)
    assert s.is_admin is True
    assert s.can_charge is False  # kill-switch off gates the action


def test_state_handles_garbage_substructs():
    p = _member_payload()
    p["card"] = "not-a-dict"
    p["monthlyCap"] = 42
    p["chargePresets"] = ["100", "bad", "250"]  # bad preset dropped, not crash
    s = billing_state_from_payload(p)
    assert s.card is None and s.monthly_cap is None
    assert s.charge_presets == (Decimal("100"), Decimal("250"))


# ---------------------------------------------------------------------------
# Error-code → typed-exception mapping (live-verified contract)
# ---------------------------------------------------------------------------


class _Headers:
    def __init__(self, d):
        self._d = d

    def get(self, k):
        return self._d.get(k)
def test_build_billing_state_builds_fallback_portal_url(monkeypatch):
    payload = _member_payload()  # no portalUrl key
    monkeypatch.setattr(nb, "get_billing_state", lambda *a, **kw: payload)
    monkeypatch.setattr(bv, "_fallback_portal_url", lambda base: "FALLBACK")
    # resolve_portal_base_url is imported into bv via local import; patch nb's.
    s = build_billing_state()
    assert s.portal_url == "FALLBACK"


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


def test_new_idempotency_key_unique_and_uuid_shaped():
    a, b = new_idempotency_key(), new_idempotency_key()
    assert a != b
    assert len(a) == 36 and a.count("-") == 4


# ---------------------------------------------------------------------------
# Amount validation (Screen 3 custom input)
# ---------------------------------------------------------------------------


def test_validate_amount_ok():
    v = validate_charge_amount("100", min_usd=Decimal("10"), max_usd=Decimal("10000"))
    assert v.ok and v.amount == Decimal("100")


def test_validate_amount_strips_dollar_sign():
    v = validate_charge_amount("$250", min_usd=Decimal("10"), max_usd=Decimal("10000"))
    assert v.ok and v.amount == Decimal("250")


@pytest.mark.parametrize(
    "raw,err_substr",
    [
        ("", "dollar amount"),
        ("0", "greater than"),
        ("-5", "greater than"),
        ("10.005", "cent"),       # multipleOf 0.01 — sub-cent rejected
        ("5", "Minimum"),         # below bounds.minUsd
        ("99999", "Maximum"),     # above bounds.maxUsd
    ],
)
def test_validate_amount_rejections(raw, err_substr):
    v = validate_charge_amount(raw, min_usd=Decimal("10"), max_usd=Decimal("10000"))
    assert not v.ok
    assert err_substr.lower() in (v.error or "").lower()
