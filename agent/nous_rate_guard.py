"""Stub module for Nous rate guard — no-op.

The Nous Portal integration was removed; every call site that lazily imports
from here keeps resolving, but the guard is inert (no rate limit state, no
throttling).
"""

from __future__ import annotations


def check_nous_rate_limit(*args, **kwargs) -> None:
    pass


def nous_rate_limit_remaining(*args, **kwargs):
    """Return None so callers treat the Nous bucket as unknown/irrelevant."""
    return None


def format_remaining(*args, **kwargs) -> str:
    return ""


def clear_nous_rate_limit(*args, **kwargs) -> None:
    pass


def is_genuine_nous_rate_limit(*args, **kwargs) -> bool:
    return False


def record_nous_rate_limit(*args, **kwargs) -> None:
    pass
