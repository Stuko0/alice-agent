"""Stub module for Nous subscription features — all managed capabilities disabled."""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional

from alice_cli.nous_account import get_nous_portal_account_info, NousPortalAccountInfo

@dataclass
class NousFeatureState:
    enabled: bool = False
    managed_by_nous: bool = False
    available: bool = False
    reason: str = "disabled"
    current_provider: Optional[str] = None

@dataclass
class NousSubscriptionFeatures:
    nous_auth_present: bool = False
    account_info: NousPortalAccountInfo = field(default_factory=NousPortalAccountInfo)
    web: NousFeatureState = field(default_factory=NousFeatureState)
    browser: NousFeatureState = field(default_factory=NousFeatureState)
    image_gen: NousFeatureState = field(default_factory=NousFeatureState)
    video_gen: NousFeatureState = field(default_factory=NousFeatureState)
    tts: NousFeatureState = field(default_factory=NousFeatureState)
    modal: NousFeatureState = field(default_factory=NousFeatureState)

    @property
    def features(self) -> dict[str, NousFeatureState]:
        return {
            "web": self.web,
            "browser": self.browser,
            "image_gen": self.image_gen,
            "video_gen": self.video_gen,
            "tts": self.tts,
            "modal": self.modal,
        }

def get_nous_subscription_features(*args, **kwargs) -> NousSubscriptionFeatures:
    return NousSubscriptionFeatures(account_info=get_nous_portal_account_info())

def _has_agent_browser(*args, **kwargs) -> bool:
    """Stub: managed Nous browser is not available (integration removed)."""
    return False

def prompt_enable_tool_gateway(*args, **kwargs) -> bool:
    return False

def managed_nous_tools_enabled(*args, **kwargs) -> bool:
    return False

def apply_nous_managed_defaults(
    config: dict,
    selected_toolsets: set[str] | list[str] | None = None,
    platform: str = "cli",
    *,
    enabled_toolsets: set[str] | list[str] | None = None,
    force_fresh: bool = False,
    **kwargs,
) -> set[str]:
    auto_configured: set[str] = set()
    toolsets = selected_toolsets or enabled_toolsets
    if not toolsets:
        return auto_configured
    sel = set(toolsets)
    if "web" in sel:
        config.setdefault("web", {})["backend"] = "firecrawl"
        auto_configured.add("web")
    if "tts" in sel:
        config.setdefault("tts", {})["provider"] = "openai"
        auto_configured.add("tts")
    if "browser" in sel:
        config.setdefault("browser", {})["cloud_provider"] = "browser-use"
        auto_configured.add("browser")
    if "image_gen" in sel:
        config.setdefault("image_gen", {})["use_gateway"] = True
        auto_configured.add("image_gen")
    if "video_gen" in sel:
        cfg = config.setdefault("video_gen", {})
        cfg["provider"] = "fal"
        cfg["use_gateway"] = True
        auto_configured.add("video_gen")
    return auto_configured

def get_nous_subscription_status(*args, **kwargs) -> dict:
    return {"status": "disabled"}

def ensure_nous_portal_access(*args, **kwargs) -> bool:
    return False

MANAGED_FEATURE_COVERAGE_CATEGORY: dict[str, str] = {
    "web": "web",
    "browser": "browser",
    "image_gen": "image_gen",
    "video_gen": "video_gen",
    "tts": "tts",
    "modal": "modal",
}
