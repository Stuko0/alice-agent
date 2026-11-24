"""Tests for the native Wayland/Hyprland computer-use backend.

Subprocess and filesystem are mocked so the suite stays hermetic: no
compositor, no grim, no real windows. Shapes mirror what Hyprland 0.56.2
actually returns (verified on the host before writing these).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from tools.computer_use import wayland_backend as wb
from tools.computer_use.backend import CaptureResult


HYPR_CLIENTS = [
    {
        "address": "0x55c8bac0c4f0",
        "mapped": True,
        "hidden": False,
        "pid": 365923,
        "class": "alice-desktop",
        "title": "Alice Agent Desktop",
        "at": [22, 70],
        "size": [1876, 1034],
        "workspace": {"id": 1},
    },
    {
        "address": "0x55deadbeef01",
        "mapped": True,
        "hidden": False,
        "pid": 1234,
        "class": "kitty",
        "title": "terminal",
        "at": [0, 0],
        "size": [800, 600],
        "workspace": {"id": 2},
    },
]

# 1x1 transparent PNG.
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _fake_run(argv, timeout=None, **_kwargs):
    result = SimpleNamespace(returncode=0, stdout="", stderr="")
    if argv[:2] == ["hyprctl", "clients"]:
        result.stdout = json.dumps(HYPR_CLIENTS)
    elif argv[:2] == ["hyprctl", "activewindow"]:
        result.stdout = json.dumps(HYPR_CLIENTS[0])
    elif argv[0] == "grim":
        with open(argv[-1], "wb") as fh:
            fh.write(PNG_BYTES)
    elif argv[:2] == ["hyprctl", "dispatch"]:
        result.stdout = "ok"
    return result


class TestAvailability:
    def test_available_with_wayland_hyprctl_and_grim(self, monkeypatch):
        monkeypatch.setattr(wb, "_is_wayland_session", lambda: True)
        monkeypatch.setattr(wb.shutil, "which", lambda n: f"/usr/bin/{n}")
        assert wb.wayland_backend_available() is True

    def test_unavailable_without_grim(self, monkeypatch):
        monkeypatch.setattr(wb, "_is_wayland_session", lambda: True)
        monkeypatch.setattr(
            wb.shutil, "which", lambda n: "/usr/bin/hyprctl" if n == "hyprctl" else None
        )
        assert wb.wayland_backend_available() is False

    def test_session_detection_falls_back_to_runtime_sockets(self, monkeypatch, tmp_path):
        # No WAYLAND_DISPLAY / XDG_SESSION_TYPE in env, but a live socket.
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
        monkeypatch.delenv("XDG_SESSION_TYPE", raising=False)
        (tmp_path / "wayland-1").touch()
        monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
        assert wb._is_wayland_session() is True

    def test_session_detection_false_on_pure_x11(self, monkeypatch, tmp_path):
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
        monkeypatch.delenv("XDG_SESSION_TYPE", raising=False)
        monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))  # no sockets
        assert wb._is_wayland_session() is False


class TestCompositorEnv:
    def test_recovers_signature_and_display_from_runtime_dir(self, monkeypatch, tmp_path):
        monkeypatch.delenv("HYPRLAND_INSTANCE_SIGNATURE", raising=False)
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
        hypr = tmp_path / "hypr" / "sig_123"
        hypr.mkdir(parents=True)
        (hypr / ".socket.sock").touch()
        # A neighbouring daemon socket must NOT be mistaken for the display.
        (tmp_path / "wayland-1-awww-daemon.sock").touch()
        (tmp_path / "wayland-1").touch()
        monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))

        env = wb._compositor_env()
        assert env["HYPRLAND_INSTANCE_SIGNATURE"] == "sig_123"
        assert env["WAYLAND_DISPLAY"] == "wayland-1"

    def test_existing_env_wins(self, monkeypatch):
        monkeypatch.setenv("HYPRLAND_INSTANCE_SIGNATURE", "keepme")
        monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-7")
        env = wb._compositor_env()
        assert env["HYPRLAND_INSTANCE_SIGNATURE"] == "keepme"
        assert env["WAYLAND_DISPLAY"] == "wayland-7"


class TestCapture:
    @pytest.fixture(autouse=True)
    def _mocked(self, monkeypatch):
        monkeypatch.setattr(wb.subprocess, "run", _fake_run)

    def test_som_capture_crops_to_target_window(self):
        seen: dict = {}

        def spy(argv, timeout=None, **_kwargs):
            seen.setdefault("calls", []).append(argv)
            return _fake_run(argv, timeout)

        with patch.object(wb.subprocess, "run", side_effect=spy):
            backend = wb.WaylandBackend()
            result = backend.capture(mode="som", app="alice-desktop")

        assert isinstance(result, CaptureResult)
        # grim's geometry argument must be "x,y WxH" for the matched window.
        grim_calls = [a for a in seen["calls"] if a and a[0] == "grim"]
        assert grim_calls, f"no grim call in {seen['calls']}"
        argv = grim_calls[0]
        assert argv[argv.index("-g") + 1] == "22,70 1876x1034"
        assert result.app == "alice-desktop"
        assert result.png_b64  # PNG bytes captured
        assert result.image_mime_type == "image/png"

    def test_elements_are_numbered_windows(self):
        backend = wb.WaylandBackend()
        result = backend.capture(mode="som")
        assert [e.index for e in result.elements] == [1, 2]
        assert {e.app for e in result.elements} == {"alice-desktop", "kitty"}
        # Bounds come straight from hyprctl.
        assert result.elements[0].bounds == (22, 70, 1876, 1034)

    def test_vision_mode_returns_no_elements(self):
        backend = wb.WaylandBackend()
        result = backend.capture(mode="vision")
        assert result.elements == []

    def test_png_size_reads_ihdr(self):
        width, height = wb.WaylandBackend._png_size(PNG_BYTES)
        assert (width, height) == (1, 1)


class TestActions:
    @pytest.fixture(autouse=True)
    def _mocked(self, monkeypatch):
        monkeypatch.setattr(wb.subprocess, "run", _fake_run)
        monkeypatch.setattr(wb, "_input_injector", lambda: None)
        # `type_text` probes `shutil.which` directly, so hiding only the
        # injector from `_input_injector` is not enough: on a host with wtype
        # installed the "degrades without injector" case would really type.
        real_which = wb.shutil.which
        monkeypatch.setattr(
            wb.shutil,
            "which",
            lambda name: None if name in {"wtype", "ydotool"} else real_which(name),
        )

    def test_click_moves_cursor_and_degrades_without_injector(self):
        backend = wb.WaylandBackend()
        backend.capture(mode="som")
        result = backend.click(element=1)
        assert result.ok is False
        # The pointer move still happened and is reported for the user.
        assert result.meta["cursor_moved"] is True
        assert result.meta["cursor"] == [22 + 1876 // 2, 70 + 1034 // 2]
        assert "ydotool" in result.message

    def test_click_without_target_is_an_error(self):
        backend = wb.WaylandBackend()
        assert backend.click().ok is False

    def test_type_text_degrades_without_injector(self):
        backend = wb.WaylandBackend()
        result = backend.type_text("hola")
        assert result.ok is False
        assert "wtype" in result.message or "ydotool" in result.message

    def test_focus_app_reports_honest_failure_when_dispatcher_rejects(self, monkeypatch):
        backend = wb.WaylandBackend()

        def failing_dispatch(expr):
            return False, "hl.focus: window not found"

        monkeypatch.setattr(backend, "_dispatch", failing_dispatch)
        result = backend.focus_app("alice-desktop")
        assert result.ok is False
        assert "focus failed" in result.message

    def test_set_value_is_unsupported_and_says_so(self):
        backend = wb.WaylandBackend()
        result = backend.set_value("x")
        assert result.ok is False
        assert "AT-SPI" in result.message


class TestIntrospection:
    @pytest.fixture(autouse=True)
    def _mocked(self, monkeypatch):
        monkeypatch.setattr(wb.subprocess, "run", _fake_run)

    def test_list_apps_groups_by_class_and_pid(self):
        backend = wb.WaylandBackend()
        apps = backend.list_apps()
        assert {(a["name"], a["window_count"]) for a in apps} == {
            ("alice-desktop", 1),
            ("kitty", 1),
        }

    def test_hidden_and_unmapped_clients_are_excluded(self, monkeypatch):
        clients = json.loads(json.dumps(HYPR_CLIENTS))
        clients[1]["mapped"] = False

        def fake_run(argv, timeout=None, **_kwargs):
            result = SimpleNamespace(returncode=0, stdout="", stderr="")
            if argv[:2] == ["hyprctl", "clients"]:
                result.stdout = json.dumps(clients)
            if argv[0] == "grim":
                with open(argv[-1], "wb") as fh:
                    fh.write(PNG_BYTES)
            return result

        monkeypatch.setattr(wb.subprocess, "run", fake_run)
        backend = wb.WaylandBackend()
        assert [a["name"] for a in backend.list_apps()] == ["alice-desktop"]
