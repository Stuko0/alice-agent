"""Stub module for Nous account info — all managed/nous capabilities disabled."""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional, Dict, Any

@dataclass
class NousPaidServiceAccessInfo:
    is_eligible: bool = False
    status: str = "disabled"
    reason: str = "none"

@dataclass
class NousPortalAccountInfo:
    is_authenticated: bool = False
    logged_in: bool = False
    inference_credential_present: bool = False
    inference_base_url: Optional[str] = None
    is_free_tier: bool = False
    source: Optional[str] = None
    fresh: bool = False
    paid_service_access: bool = False
    tool_gateway_entitled: bool = False
    email: Optional[str] = None
    user_id: Optional[str] = None
    has_active_subscription: bool = False
    plan_name: Optional[str] = None
    credits_balance: float = 0.0
    tool_access: Dict[str, Any] = field(default_factory=dict)

    def tool_gateway_entitled_for(self, *args, **kwargs) -> bool:
        return False

def get_nous_portal_account_info(*args, **kwargs) -> NousPortalAccountInfo:
    return NousPortalAccountInfo()

def format_nous_portal_entitlement_message(account_info=None, capability="", **kwargs) -> str:
    if account_info and getattr(account_info, "inference_credential_present", False):
        return "Nous inference credentials are configured"
    return ""

def nous_portal_topup_url(account_info=None, *args, **kwargs):
    """Stub: no portal top-up URL (integration removed)."""
    return None
