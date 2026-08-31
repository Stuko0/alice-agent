"""Stub module for Nous Portal proxy adapter — disabled."""

from __future__ import annotations
from alice_cli.proxy.adapters.base import UpstreamAdapter

class NousPortalAdapter(UpstreamAdapter):
    def resolve_credentials(self, *args, **kwargs):
        return None
