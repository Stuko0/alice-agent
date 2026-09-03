"""Tests for the pure-Wayland placeholder guard.

On a pure-Wayland session, cua-driver's Linux backend (X11/XWayland) can only
enumerate pseudo windows: the compositor's XWayland anchor (null pid, ~10x10)
plus the driver's own cursor-overlay surface. Real app windows are not X11
clients, so computer_use is inoperable — but health_report's infra checks
(X11 reachable, AT-SPI up) all pass, and `capture()` used to "succeed" with a
blank screenshot and an empty element tree.

The guard has three layers, tested here:

1. ``_is_wayland_placeholder_enum`` — the signature discriminator
   (``tools/computer_use/cua_backend.py``).
2. ``capture()`` — fails fast with an actionable RuntimeError instead of
   returning a useless CaptureResult.
3. ``doctor._wayland_window_probe`` — synthesizes a failed check and
   downgrades overall → failed → exit 1, so `alice computer-use doctor`
   stops reporting "ok" on hosts where the tool cannot work.

Shapes below are lifted from a real pure-Wayland host (Hyprland, cua-driver
0.7.1): anchor "Hyprland :D" 10x10 pid=null, overlay
"Cua.AgentCursorOverlay.default" 1920x1200 pid=null.
"""

from __future__ import annotations

import json
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest


# ── fixture data: real host shapes ───────────────────────────────────────────

ANCHOR = {
    "app_name": "",
    "bounds": {"height": 10, "width": 10, "x": 0, "y": 0},
    "pid": None,
    "title": "Hyprland :D",
    "window_id": 2097157,
}

OVERLAY = {
    "app_name": "",
    "bounds": {"height": 1200, "width": 1920, "x": 0, "y": 0},
    "pid": None,
    "title": "Cua.AgentCursorOverlay.default",
    "window_id": 4194305,
}


# ── 1. signature discriminator ───────────────────────────────────────────────


class TestWaylandPlaceholderEnum:
    def test_anchor_plus_overlay_is_placeholder(self):
        """The real pure-Wayland enumeration: compositor anchor + the
        driver's own cursor overlay. Nothing drivable."""
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        assert _is_wayland_placeholder_enum([ANCHOR, OVERLAY]) is True

    def test_overlay_only_is_placeholder(self):
        """Compositors that don't expose an anchor: the driver's overlay is
        the only window — still nothing drivable."""
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        assert _is_wayland_placeholder_enum([OVERLAY]) is True

    def test_empty_is_placeholder(self):
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        assert _is_wayland_placeholder_enum([]) is True

    def test_healthy_x11_is_not_placeholder(self):
        """A real X11 desktop window carries a pid — never the signature."""
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        real = {
            "app_name": "firefox",
            "bounds": {"height": 800, "width": 1200, "x": 0, "y": 0},
            "pid": 1234,
            "title": "Firefox",
            "window_id": 99,
        }
        assert _is_wayland_placeholder_enum([real, OVERLAY]) is False

    def test_wayland_with_xwayland_app_is_not_placeholder(self):
        """A Wayland session where the target app runs under XWayland: the
        anchor + overlay + a real pid-carrying app window → healthy."""
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        xwayland_app = {
            "app_name": "xterm",
            "bounds": {"height": 400, "width": 600, "x": 0, "y": 0},
            "pid": 5678,
            "title": "xterm",
            "window_id": 77,
        }
        assert _is_wayland_placeholder_enum([ANCHOR, OVERLAY, xwayland_app]) is False

    def test_two_pidless_windows_is_not_placeholder(self):
        """>1 null-pid non-overlay windows is not the known signature — be
        conservative and don't block (fail-open, not fail-closed)."""
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        second = dict(ANCHOR, window_id=123, title="mystery")
        assert _is_wayland_placeholder_enum([ANCHOR, second]) is False

    def test_unnamed_tiny_anchor_is_placeholder(self):
        """wlroots compositors can name the anchor "" — the size check (tiny
        null-pid window) still catches it."""
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        unnamed = dict(ANCHOR, title="")
        assert _is_wayland_placeholder_enum([unnamed]) is True

    def test_compositor_named_anchor_of_any_size_is_placeholder(self):
        """A compositor-named anchor with non-default bounds (user resized
        the XWayland root?) is still the anchor."""
        from tools.computer_use.cua_backend import _is_wayland_placeholder_enum

        big_anchor = dict(ANCHOR, bounds={"height": 600, "width": 800, "x": 0, "y": 0})
        assert _is_wayland_placeholder_enum([big_anchor, OVERLAY]) is True


# ── 2. capture() fail-fast ───────────────────────────────────────────────────


class TestCaptureWaylandGuard:
    def _backend_with_windows(self, windows: list, window_state: dict | None = None):
        """Build a CuaDriverBackend-shaped object whose session returns the
        given list_windows payload. Skips __init__ (no real driver spawn)."""
        from tools.computer_use import cua_backend

        backend = cua_backend.CuaDriverBackend.__new__(cua_backend.CuaDriverBackend)
        backend._session_id = "test-session"
        backend._last_app = None  # set in __init__; capture() reads it
        session = MagicMock()

        def _call_tool(name, args=None, **kw):
            if name == "list_windows":
                return {"structuredContent": {"windows": windows}}
            if name == "get_window_state":
                if window_state is not None:
                    return window_state
                # Minimal well-formed som-mode payload: empty tree, no
                # screenshot, no structured elements.
                return {"data": "✅ xterm — 0 elements", "structuredContent": {}}
            return {}

        session.call_tool = MagicMock(side_effect=_call_tool)
        backend._session = session
        return backend

    def test_pure_wayland_capture_raises_actionable(self):
        backend = self._backend_with_windows([ANCHOR, OVERLAY])
        with pytest.raises(RuntimeError, match="XWayland"):
            backend.capture()

    def test_healthy_capture_does_not_raise(self):
        """A pid-carrying app window (X11 desktop or XWayland app on a
        Wayland session) is NOT the placeholder signature: capture proceeds
        past the guard. The full get_window_state payload is backend
        territory — here we assert the guard didn't fire and the driver
        interaction advanced to the window-state call."""
        real = {
            "app_name": "xterm",
            "bounds": {"height": 400, "width": 600, "x": 0, "y": 0},
            "pid": 5678,
            "title": "xterm",
            "window_id": 77,
            "z_index": 0,
        }
        backend = self._backend_with_windows([real])
        try:
            backend.capture()
        except RuntimeError as e:
            # The guard must not have fired — any other failure is the mocked
            # get_window_state payload missing fields, which is fine here.
            assert "Wayland" not in str(e), f"placeholder guard fired on a healthy window: {e}"
        # Guard passed: the driver was asked for the window's state.
        called = [c.args[0] for c in backend._session.call_tool.call_args_list]
        assert "get_window_state" in called

    def test_null_pid_no_longer_crashes_int_cast(self):
        """Pre-guard bug: `int(w["pid"])` raised TypeError on the anchor's
        null pid before any Wayland message could be produced. The pid
        coercion now tolerates None (sentinel -1)."""
        backend = self._backend_with_windows([ANCHOR, OVERLAY])
        with pytest.raises(RuntimeError, match="Wayland"):
            backend.capture()


# ── 3. doctor probe ──────────────────────────────────────────────────────────


def _probe_proc_with(windows: list) -> MagicMock:
    """Popen mock whose list_windows call returns the given windows."""
    lw_response = {
        "jsonrpc": "2.0",
        "id": 2,
        "result": {"structuredContent": {"windows": windows}},
    }
    lines = [
        json.dumps({"jsonrpc": "2.0", "id": 1, "result": {}}) + "\n",
        json.dumps(lw_response) + "\n",
        "",
    ]
    proc = MagicMock()
    proc.stdin = MagicMock()
    proc.stdout = MagicMock()
    proc.stdout.readline = MagicMock(side_effect=lines)
    proc.stderr = MagicMock()
    proc.wait = MagicMock(return_value=0)
    proc.kill = MagicMock()
    return proc


_OK_REPORT = {
    "schema_version": "1",
    "platform": "linux",
    "driver_version": "0.7.1",
    "overall": "ok",
    "checks": [
        {"name": "binary_version", "status": "pass", "message": "cua-driver 0.7.1"},
    ],
}


def _health_proc() -> MagicMock:
    """Popen mock for the health_report handshake (all checks pass)."""
    lines = [
        json.dumps({"jsonrpc": "2.0", "id": 1, "result": {}}) + "\n",
        json.dumps({
            "jsonrpc": "2.0", "id": 2,
            "result": {"structuredContent": _OK_REPORT},
        }) + "\n",
        "",
    ]
    proc = MagicMock()
    proc.stdin = MagicMock()
    proc.stdout = MagicMock()
    proc.stdout.readline = MagicMock(side_effect=lines)
    proc.stderr = MagicMock()
    proc.stderr.read = MagicMock(return_value="")
    proc.wait = MagicMock(return_value=0)
    proc.kill = MagicMock()
    return proc


class TestDoctorWaylandProbe:
    @pytest.mark.skipif(
        __import__("sys").platform != "linux",
        reason="probe only runs on linux",
    )
    def test_pure_wayland_downgrades_to_failed(self, capsys):
        """health_report says ok, but list_windows only sees the anchor +
        overlay → synthesized check, overall=failed, exit 1."""
        from tools.computer_use import doctor

        with patch("shutil.which", return_value="/fake/cua-driver"), \
             patch("subprocess.Popen", side_effect=[_health_proc(), _probe_proc_with([ANCHOR, OVERLAY])]):
            code = doctor.run_doctor()

        assert code == 1
        out = capsys.readouterr().out
        assert "linux-wayland-window-enum" in out
        assert "Wayland" in out

    @pytest.mark.skipif(
        __import__("sys").platform != "linux",
        reason="probe only runs on linux",
    )
    def test_healthy_windows_keep_ok(self, capsys):
        """A real pid-carrying window (X11 or XWayland app) → probe passes,
        overall stays ok, exit 0."""
        from tools.computer_use import doctor

        real = {
            "app_name": "xterm",
            "bounds": {"height": 400, "width": 600, "x": 0, "y": 0},
            "pid": 5678,
            "title": "xterm",
            "window_id": 77,
        }
        with patch("shutil.which", return_value="/fake/cua-driver"), \
             patch("subprocess.Popen", side_effect=[_health_proc(), _probe_proc_with([real])]):
            code = doctor.run_doctor()

        assert code == 0
        out = capsys.readouterr().out
        assert "linux-wayland-window-enum" not in out

    @pytest.mark.skipif(
        __import__("sys").platform != "linux",
        reason="probe only runs on linux",
    )
    def test_probe_failure_never_breaks_doctor(self, capsys):
        """The probe itself dying (driver crash mid-probe) must not turn a
        diagnostic command into a protocol error: run_doctor keeps the
        health_report verdict (exit 0 for ok)."""
        from tools.computer_use import doctor

        with patch("shutil.which", return_value="/fake/cua-driver"), \
             patch("subprocess.Popen", side_effect=[_health_proc(), OSError("boom")]):
            code = doctor.run_doctor()

        assert code == 0

    @pytest.mark.skipif(
        __import__("sys").platform != "linux",
        reason="probe only runs on linux",
    )
    def test_json_output_includes_synthesized_check(self, capsys):
        from tools.computer_use import doctor

        with patch("shutil.which", return_value="/fake/cua-driver"), \
             patch("subprocess.Popen", side_effect=[_health_proc(), _probe_proc_with([ANCHOR])]), \
             patch("sys.stdout", new_callable=StringIO) as fake_out:
            code = doctor.run_doctor(json_output=True)

        assert code == 1
        payload = json.loads(fake_out.getvalue())
        names = [c["name"] for c in payload["checks"]]
        assert "linux-wayland-window-enum" in names
        assert payload["overall"] == "failed"
