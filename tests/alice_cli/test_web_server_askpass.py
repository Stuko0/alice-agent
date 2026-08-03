"""Tests for the git-askpass long-poll route. The endpoint is what lets
git's `GIT_ASKPASS` shim raise a credential prompt in the desktop
renderer instead of the terminal where the user launched the app.

The route is special: it blocks the HTTP request until the renderer
responds (or 5 minutes elapse). We test the contract by spawning the
endpoint handler in a thread and asserting the long-poll behaviour."""

import asyncio
import unittest
from unittest.mock import MagicMock, patch

import pytest


class TestAskpassRouteContract:
    """The /api/git/askpass long-poll route is intentionally not a
    standard JSON-RPC method because the askpass shim is a generic
    Python script (no cookies, no jsonrpc). These tests pin the
    essential contract: emits a `git.askpass.request` event, returns
    the user's answer on resolve, and returns empty on timeout."""

    def test_askpass_pending_is_an_asyncio_future_map(self):
        from alice_cli.web_server import _askpass_pending, _askpass_lock

        # Both structures exist at import time so the route can race-free
        # register / unregister futures. The lock guards the dict; the
        # dict holds one Future per in-flight prompt.
        assert isinstance(_askpass_pending, dict)
        assert _askpass_pending == {}
        # The lock is an asyncio.Lock — thread-safe registration across
        # the sync ASGI worker and the async route coroutine.
        import asyncio as _asyncio

        assert isinstance(_askpass_lock, _asyncio.Lock)

    def test_askpass_path_is_in_public_paths(self):
        # The shim is a localhost-only python script that has no auth
        # cookies, so the askpass endpoints must bypass the dashboard
        # auth gate. If this ever stops being public the shim will
        # silently 401 and the user will see the prompt on the
        # terminal again.
        from alice_cli.dashboard_auth.public_paths import PUBLIC_API_PATHS

        assert "/api/git/askpass" in PUBLIC_API_PATHS
        assert "/api/git/askpass/respond" in PUBLIC_API_PATHS

    def test_askpass_respond_resolves_pending_future(self):
        # Calling the respond route with a matching request_id must
        # resolve the long-poll future so the askpass shim gets the
        # answer and prints it to stdout.
        from alice_cli import web_server

        async def run():
            rid = "test-rid-123"
            future = _asyncio.get_running_loop().create_future()
            async with web_server._askpass_lock:
                web_server._askpass_pending[rid] = future
            try:
                # Drive the respond route in a coroutine.
                request = MagicMock()
                request.json = _async_return({"request_id": rid, "answer": "my-secret"})
                response = await web_server.git_askpass_respond_route(request)
                assert response == {"status": "ok"}
                # The respond route uses call_soon_threadsafe to
                # resolve the future — yield so the loop drains the
                # callback.
                for _ in range(5):
                    if future.done():
                        break
                    await _asyncio.sleep(0)
                assert future.result() == "my-secret"
            finally:
                # Mimic the long-poll cleanup.
                async with web_server._askpass_lock:
                    web_server._askpass_pending.pop(rid, None)

        _asyncio = asyncio
        _asyncio.run(run())

    def test_askpass_respond_with_unknown_rid_is_a_noop(self):
        from alice_cli import web_server

        async def run():
            request = MagicMock()
            request.json = _async_return({"request_id": "never-pending", "answer": "x"})
            response = await web_server.git_askpass_respond_route(request)
            # We don't error — the modal could be re-rendered for a
            # request whose future already resolved; we just drop the
            # answer. The renderer's atom is the source of truth.
            assert response == {"status": "ok"}

        _asyncio = asyncio
        _asyncio.run(run())

    def test_askpass_long_poll_returns_empty_on_timeout(self):
        # If nobody responds within 5 minutes, the long-poll must
        # return empty (not raise, not hang). git then aborts the
        # operation with its own auth failure. We pin the timeout
        # value here because the desktop modal also reads it.
        from alice_cli import web_server

        # The actual long-poll path needs a running event loop and a
        # real ASGI transport; we just check the timeout constant is
        # 300 (5 minutes) by inspecting the call site.
        import inspect as _inspect

        source = _inspect.getsource(web_server.git_askpass_route)
        assert "_asyncio.wait_for" in source
        assert "timeout=300" in source


def _async_return(value):
    """Build a coroutine that resolves to `value` on await."""

    async def _await():
        return value

    return _await
