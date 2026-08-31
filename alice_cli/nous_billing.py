"""Stub module for Nous billing — disabled."""

from __future__ import annotations

import os

class BillingError(Exception):
    portal_url: str | None = None

class BillingRateLimited(BillingError):
    pass

class BillingAuthError(BillingError):
    pass

class BillingScopeRequired(BillingError):
    pass

def _absolutize_portal_url(url: str | None) -> str | None:
    if not url:
        return url
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = os.environ.get("ALICE_PORTAL_BASE_URL", "https://alice-agent.stuko.dev")
    return f"{base.rstrip('/')}/{url.lstrip('/')}"

def resolve_portal_base_url(*args, **kwargs) -> str:
    """Stub: point at the generic docs portal (integration removed)."""
    return os.environ.get("ALICE_PORTAL_BASE_URL", "https://alice-agent.stuko.dev")

def _raise_for_error(status_code: int, data: dict):
    portal_url = _absolutize_portal_url(data.get("portalUrl") if isinstance(data, dict) else None)
    msg = data.get("error", "Billing error") if isinstance(data, dict) else "Billing error"
    err = BillingError(msg)
    err.portal_url = portal_url
    raise err

def post_charge(*args, **kwargs):
    raise BillingError("Billing is disabled")

def get_charge_status(*args, **kwargs):
    raise BillingError("Billing is disabled")

def patch_auto_top_up(*args, **kwargs):
    raise BillingError("Billing is disabled")

def get_billing_state(*args, **kwargs):
    raise BillingError("Billing is disabled")
