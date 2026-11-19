"""Native Wayland backend for computer use (Hyprland + grim).

Why this exists
---------------
The bundled `cua-driver` Linux backend enumerates windows and captures the
screen over **X11 only** (`_NET_CLIENT_LIST`, `XSendEvent`, `XGetImage`).
On a pure-Wayland session no native app window is an X11 client, so the
X11 path sees only the compositor's anchor surface and every capture fails
(`X11Error ... request_name: "GetImage"`). Even with
`CUA_DRIVER_RS_ENABLE_WAYLAND=1` the driver advertises the wlroots globals
(`foreign-toplevel`, `screencopy`, `virtual-pointer`) but no tool consumes
them yet (verified on cua-driver 0.7.1, Hyprland 0.56.2).

This backend drives the same job through the compositor's own tooling:

=================  ==========================================
Capability         Mechanism
=================  ==========================================
Enumerate windows  ``hyprctl clients -j`` (address, pid, class,
                   title, geometry)
Capture screen     ``grim`` (wlroots screencopy), optionally
                   window-cropped via ``-g "x,y WxH"``
Move pointer       ``hyprctl dispatch 'hl.dsp.cursor.move(...)'``
Focus window       ``hyprctl dispatch 'hl.dsp.focus({window=...})'``
Click / type /     NOT available from the compositor. Hyprland
scroll             exposes no dispatcher for button or key
                   injection, so these require an external
                   injector (``ydotool`` preferred, ``wtype``
                   for keyboard) and degrade to an explicit
                   "unsupported" result when absent.
=================  ==========================================

Hyprland 0.56 speaks Lua for ``hyprctl dispatch`` (the pre-0.49
``dispatch focuswindow address:0x..`` spelling is rejected), which is why
every dispatcher below is written as ``hl.dsp.*``.

This backend is chosen only on a pure-Wayland session where the X11 path
is provably blind; an XWayland app inside a Wayland session still belongs
to `CuaDriverBackend`, whose X11 enumeration sees it.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from tools.computer_use.backend import (
    ActionResult,
    CaptureResult,
    ComputerUseBackend,
    UIElement,
)

_HYPRCTL_TIMEOUT_S = 10
_GRIM_TIMEOUT_S = 15
# ydotool button codes (Linux input-event codes | 0xC0): left 0xC0,
# right 0xC1, middle 0xC2. Kept explicit because ydotool rejects positional
# args and its --help is not readable from a subprocess in all versions.
_YDOTOOL_BUTTON = {"left": "0xC0", "right": "0xC1", "middle": "0xC2"}


def _run(argv: List[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=_compositor_env(),
    )


def _compositor_env() -> Dict[str, str]:
    """Environment needed to reach a live Hyprland/Wayland session.

    Alice's own process routinely runs WITHOUT the graphical session's
    environment — spawned by the desktop shell, a systemd unit, or the
    gateway — so `hyprctl` answers "HYPRLAND_INSTANCE_SIGNATURE not set!"
    and `grim` fails with `wl_display_roundtrip() failed` even though the
    session is perfectly healthy. Both identities are recoverable from the
    runtime dir (verified on Hyprland 0.56.2), so complete the env instead
    of failing on a process that simply never inherited it.
    """
    import os

    env = dict(os.environ)
    uid = os.getuid()
    runtime = env.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}"
    env.setdefault("XDG_RUNTIME_DIR", runtime)

    if not env.get("HYPRLAND_INSTANCE_SIGNATURE"):
        try:
            sockets = sorted(
                Path(runtime).glob("hypr/*/.socket.sock"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            if sockets:
                env["HYPRLAND_INSTANCE_SIGNATURE"] = sockets[0].parent.name
        except OSError:
            pass

    if not env.get("WAYLAND_DISPLAY"):
        # Only bare `wayland-N` names are the compositor's display socket;
        # neighbours such as `wayland-1-awww-daemon.sock` belong to other
        # daemons and make grim fail with a roundtrip error.
        try:
            displays = [
                p.name
                for p in Path(runtime).glob("wayland-*")
                if p.name.removeprefix("wayland-").isdigit()
            ]
            if displays:
                env["WAYLAND_DISPLAY"] = sorted(displays)[-1]
        except OSError:
            pass

    # ydotool's client defaults its socket to $XDG_RUNTIME_DIR/.ydotool_socket,
    # but ydotoold runs as a ROOT system service and creates the socket at its
    # own default, /tmp/.ydotool_socket (started with --socket-perm=0666 so the
    # unprivileged client can reach it). Point the client at the daemon's actual
    # socket instead of a path that never exists.
    if not env.get("YDOTOOL_SOCKET"):
        for candidate in ("/tmp/.ydotool_socket", f"{runtime}/.ydotool_socket"):
            if Path(candidate).exists():
                env["YDOTOOL_SOCKET"] = candidate
                break

    return env


def _is_wayland_session() -> bool:
    """True on a Wayland session — env-derived, with a filesystem fallback.

    The env alone is unreliable here: a backend spawned by the desktop
    shell or a systemd unit has neither `WAYLAND_DISPLAY` nor
    `XDG_SESSION_TYPE` even though the user is sitting on Wayland. The
    runtime-dir sockets are the ground truth.
    """
    import os

    if os.environ.get("WAYLAND_DISPLAY"):
        return True
    if os.environ.get("XDG_SESSION_TYPE", "").strip().lower() == "wayland":
        return True
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    try:
        return any(
            p.name.removeprefix("wayland-").isdigit()
            for p in Path(runtime).glob("wayland-*")
        )
    except OSError:
        return False


def wayland_backend_available() -> bool:
    """True when this host can drive the compositor natively."""
    return (
        _is_wayland_session()
        and shutil.which("hyprctl") is not None
        and shutil.which("grim") is not None
    )


def _input_injector() -> Optional[str]:
    """Best available button/keyboard injector, or None (capture-only)."""
    if shutil.which("ydotool"):
        return "ydotool"
    if shutil.which("wtype"):
        return "wtype"
    return None


class WaylandBackend(ComputerUseBackend):
    """Compositor-native computer use for Hyprland sessions."""

    def __init__(self) -> None:
        self._started = False
        self._last_elements: List[UIElement] = []

    # ── Lifecycle ───────────────────────────────────────────────────
    def start(self) -> None:
        self._started = True

    def stop(self) -> None:
        self._started = False
        self._last_elements = []

    def is_available(self) -> bool:
        return wayland_backend_available()

    # ── Compositor helpers ──────────────────────────────────────────
    def _dispatch(self, lua_expr: str) -> Tuple[bool, str]:
        proc = _run(["hyprctl", "dispatch", lua_expr], _HYPRCTL_TIMEOUT_S)
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        text = out or err
        ok = proc.returncode == 0 and not text.lower().startswith(
            ("error", "warning", "not enough")
        )
        return ok, text

    def _clients(self) -> List[Dict[str, Any]]:
        proc = _run(["hyprctl", "clients", "-j"], _HYPRCTL_TIMEOUT_S)
        try:
            data = json.loads(proc.stdout or "[]")
        except json.JSONDecodeError:
            return []
        return [c for c in data if isinstance(c, dict)]

    def _active_window(self) -> Dict[str, Any]:
        proc = _run(["hyprctl", "activewindow", "-j"], _HYPRCTL_TIMEOUT_S)
        try:
            data = json.loads(proc.stdout or "{}")
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _address_int(address: str) -> int:
        try:
            return int(str(address).replace("0x", ""), 16)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _visible(client: Dict[str, Any]) -> bool:
        return bool(client.get("mapped")) and not bool(client.get("hidden"))

    def _target_window(self, app: Optional[str]) -> Dict[str, Any]:
        """Window to capture: matching `app` (class/title substring), else
        the focused window, else the largest visible window."""
        clients = [c for c in self._clients() if self._visible(c)]
        if app:
            needle = app.strip().lower()
            for c in clients:
                if needle in str(c.get("class", "")).lower() or needle in str(
                    c.get("title", "")
                ).lower():
                    return c
        active = self._active_window()
        if active and self._visible(active):
            return active
        if clients:
            return max(
                clients,
                key=lambda c: (c.get("size") or [0, 0])[0]
                * (c.get("size") or [0, 0])[1],
            )
        return {}

    def _capture_png(
        self, target: Optional[Dict[str, Any]]
    ) -> Tuple[Optional[bytes], Tuple[int, int]]:
        """grim the target window (or the whole layout) into PNG bytes."""
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            out_path = fh.name
        argv = ["grim"]
        if target and target.get("at") and target.get("size"):
            x, y = target["at"]
            w, h = target["size"]
            # grim's geometry is "x,y WxH" (an 'x' between width and height).
            argv += ["-g", f"{x},{y} {w}x{h}"]
        argv.append(out_path)
        proc = _run(argv, _GRIM_TIMEOUT_S)
        path = Path(out_path)
        try:
            if proc.returncode != 0 or not path.exists() or path.stat().st_size == 0:
                return None, (0, 0)
            size = self._png_size(path.read_bytes())
            return path.read_bytes(), size
        finally:
            path.unlink(missing_ok=True)

    @staticmethod
    def _png_size(data: bytes) -> Tuple[int, int]:
        # PNG IHDR: 16..24 hold width/height as big-endian uint32.
        if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
            width = int.from_bytes(data[16:20], "big")
            height = int.from_bytes(data[20:24], "big")
            return width, height
        return 0, 0

    @staticmethod
    def _draw_som_overlay(png: bytes, elements: List[UIElement]) -> bytes:
        """Number each window on the capture so the model can click by index.

        Falls back to the raw capture when Pillow is unavailable — the
        vision path still works, only the numbered affordance is lost.
        """
        try:
            import io

            from PIL import Image, ImageDraw
        except ImportError:
            return png

        img = Image.open(io.BytesIO(png)).convert("RGB")
        draw = ImageDraw.Draw(img, "RGBA")
        # Windows are often stacked at identical bounds (fullscreen /
        # same-workspace). Numbering them in place would stack the badges
        # too and only the last would be readable, so nudge each badge down
        # by its index when a previous one already occupies the corner.
        placed: List[Tuple[int, int]] = []
        for el in elements:
            x, y, w, h = el.bounds
            draw.rectangle([x, y, x + w - 1, y + h - 1], outline=(240, 90, 90, 220), width=2)
            badge = str(el.index)
            bx, by = x + 6, y + 6
            while (bx, by) in placed:
                by += 26
            placed.append((bx, by))
            draw.rectangle([bx, by, bx + 14 + 8 * len(badge), by + 22], fill=(20, 20, 20, 230))
            draw.text((bx + 6, by + 5), badge, fill=(255, 230, 90))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    # ── Capture ─────────────────────────────────────────────────────
    def capture(self, mode: str = "som", app: Optional[str] = None) -> CaptureResult:
        target = self._target_window(app)
        png, (width, height) = self._capture_png(target if target else None)

        elements: List[UIElement] = []
        if mode in ("ax", "som"):
            for i, c in enumerate(
                [c for c in self._clients() if self._visible(c)], start=1
            ):
                at = c.get("at") or [0, 0]
                size = c.get("size") or [0, 0]
                elements.append(
                    UIElement(
                        index=i,
                        role="AXWindow",
                        label=f"{c.get('class', '')}: {c.get('title', '')}".strip(": "),
                        bounds=(at[0], at[1], size[0], size[1]),
                        app=str(c.get("class", "")),
                        pid=int(c.get("pid") or 0),
                        window_id=self._address_int(str(c.get("address", ""))),
                    )
                )
        self._last_elements = elements

        if png and mode == "som" and elements:
            png = self._draw_som_overlay(png, elements)
            width, height = self._png_size(png) or (width, height)

        return CaptureResult(
            mode=mode,
            width=width,
            height=height,
            png_b64=base64.b64encode(png).decode("ascii") if png else None,
            elements=elements if mode in ("ax", "som") else [],
            app=str(target.get("class", "")) if target else "",
            window_title=str(target.get("title", "")) if target else "",
            png_bytes_len=len(png or b""),
            image_mime_type="image/png" if png else None,
        )

    # ── Element resolution ──────────────────────────────────────────
    def _resolve_center(
        self, element: Optional[int], x: Optional[int], y: Optional[int]
    ) -> Tuple[Optional[int], Optional[int]]:
        if x is not None and y is not None:
            return x, y
        if element is not None:
            for el in self._last_elements:
                if el.index == element:
                    return el.center()
        return None, None

    def _move_pointer(self, x: int, y: int) -> Tuple[bool, str]:
        return self._dispatch(f"hl.dsp.cursor.move({{x={x}, y={y}}})")

    # ── Pointer actions ─────────────────────────────────────────────
    def click(
        self,
        *,
        element: Optional[int] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        button: str = "left",
        click_count: int = 1,
        modifiers: Optional[List[str]] = None,
    ) -> ActionResult:
        cx, cy = self._resolve_center(element, x, y)
        if cx is None or cy is None:
            return ActionResult(
                ok=False,
                action="click",
                message="click needs an element index or explicit x/y",
            )
        moved_ok, moved_msg = self._move_pointer(cx, cy)

        injector = _input_injector()
        if injector != "ydotool":
            return ActionResult(
                ok=False,
                action="click",
                message=(
                    f"pointer moved to ({cx},{cy}) but button injection is "
                    "unavailable: Hyprland exposes no click dispatcher. "
                    "Install ydotool (`sudo dnf install ydotool`) to enable "
                    "clicks, or relaunch the target app under XWayland."
                ),
                meta={"cursor_moved": moved_ok, "cursor": [cx, cy]},
            )

        code = _YDOTOOL_BUTTON.get(button, "0xC0")
        repeats = max(1, min(int(click_count), 5))
        proc = _run(
            ["ydotool", "click", "--repeat", str(repeats), code], _HYPRCTL_TIMEOUT_S
        )
        ok = proc.returncode == 0
        return ActionResult(
            ok=ok,
            action="click",
            message=(
                f"clicked {button} at ({cx},{cy})"
                if ok
                else f"ydotool click failed: {(proc.stderr or proc.stdout).strip()[:200]}"
            ),
            meta={"cursor": [cx, cy], "injector": injector},
        )

    def drag(
        self,
        *,
        from_element: Optional[int] = None,
        to_element: Optional[int] = None,
        from_xy: Optional[Tuple[int, int]] = None,
        to_xy: Optional[Tuple[int, int]] = None,
        button: str = "left",
        modifiers: Optional[List[str]] = None,
    ) -> ActionResult:
        start = from_xy
        end = to_xy
        if start is None and from_element is not None:
            for el in self._last_elements:
                if el.index == from_element:
                    start = el.center()
        if end is None and to_element is not None:
            for el in self._last_elements:
                if el.index == to_element:
                    end = el.center()
        if not start or not end:
            return ActionResult(
                ok=False,
                action="drag",
                message="drag needs from/to elements or coordinates",
            )

        code = _YDOTOOL_BUTTON.get(button, "0xC0")
        if _input_injector() != "ydotool":
            self._move_pointer(start[0], start[1])
            return ActionResult(
                ok=False,
                action="drag",
                message=(
                    "drag needs button hold/release, which only ydotool "
                    "provides on Wayland. Install ydotool or use XWayland."
                ),
                meta={"cursor": list(start)},
            )

        down = _run(["ydotool", "click", code], _HYPRCTL_TIMEOUT_S)
        steps = 12
        for i in range(1, steps + 1):
            sx = start[0] + (end[0] - start[0]) * i // steps
            sy = start[1] + (end[1] - start[1]) * i // steps
            self._move_pointer(sx, sy)
        up = _run(["ydotool", "click", code], _HYPRCTL_TIMEOUT_S)
        ok = down.returncode == 0 and up.returncode == 0
        return ActionResult(
            ok=ok,
            action="drag",
            message=f"dragged {start} -> {end}" if ok else "ydotool drag failed",
            meta={"from": list(start), "to": list(end)},
        )

    def scroll(
        self,
        *,
        direction: str,
        amount: int = 3,
        element: Optional[int] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        modifiers: Optional[List[str]] = None,
    ) -> ActionResult:
        cx, cy = self._resolve_center(element, x, y)
        if cx is not None and cy is not None:
            self._move_pointer(cx, cy)
        if _input_injector() != "ydotool":
            return ActionResult(
                ok=False,
                action="scroll",
                message="scroll needs wheel injection (ydotool) on Wayland",
                meta={"cursor": [cx, cy]},
            )
        # ydotool scroll takes a signed distance; 15 ≈ one wheel tick.
        sign = -1 if direction in ("up", "left") else 1
        distance = sign * 15 * max(1, min(int(amount), 20))
        proc = _run(["ydotool", "scroll", str(distance)], _HYPRCTL_TIMEOUT_S)
        return ActionResult(
            ok=proc.returncode == 0,
            action="scroll",
            message=f"scrolled {direction} x{amount}",
        )

    # ── Keyboard ────────────────────────────────────────────────────
    def type_text(self, text: str) -> ActionResult:
        if not text:
            return ActionResult(ok=True, action="type", message="nothing to type")

        # Same detection as click()/key(): one place decides whether an
        # injector exists, so a caller (or a test) that pins it to None gets
        # the honest "unavailable" answer instead of a surprise dispatch.
        injector = _input_injector()

        if injector == "wtype":
            proc = _run(["wtype", "--", text], _HYPRCTL_TIMEOUT_S)
            return ActionResult(
                ok=proc.returncode == 0,
                action="type",
                message=f"typed {len(text)} chars via wtype",
            )
        if injector == "ydotool":
            proc = _run(["ydotool", "type", "--", text], _HYPRCTL_TIMEOUT_S)
            return ActionResult(
                ok=proc.returncode == 0,
                action="type",
                message=f"typed {len(text)} chars via ydotool",
            )
        return ActionResult(
            ok=False,
            action="type",
            message=(
                "keyboard injection unavailable: install wtype or ydotool "
                "(`sudo dnf install wtype`) — the compositor has no typing "
                "dispatcher."
            ),
        )

    def key(self, keys: str) -> ActionResult:
        injector = _input_injector()
        if injector is None:
            return ActionResult(
                ok=False,
                action="key",
                message="keyboard injection unavailable (install wtype or ydotool)",
            )
        combo = [k for k in keys.lower().split("+") if k]
        mods = {"ctrl": "CTRL", "alt": "ALT", "shift": "SHIFT", "cmd": "SUPER", "super": "SUPER"}
        if injector == "wtype":
            argv: List[str] = []
            for k in combo:
                if k in mods:
                    argv += ["-M", mods[k]]
                else:
                    argv += ["-k", k]
            for k in reversed(combo):
                if k in mods:
                    argv += ["-m", mods[k]]
            proc = _run(["wtype"] + argv, _HYPRCTL_TIMEOUT_S)
        else:
            proc = _run(["ydotool", "key"] + ["+".join(combo)], _HYPRCTL_TIMEOUT_S)
        return ActionResult(
            ok=proc.returncode == 0,
            action="key",
            message=f"sent {keys} via {injector}",
        )

    # ── Introspection ───────────────────────────────────────────────
    def list_apps(self) -> List[Dict[str, Any]]:
        apps: Dict[Tuple[str, int], Dict[str, Any]] = {}
        for c in self._clients():
            if not self._visible(c):
                continue
            key = (str(c.get("class", "")), int(c.get("pid") or 0))
            entry = apps.setdefault(
                key,
                {
                    "name": key[0],
                    "bundle_id": key[0],
                    "pid": key[1],
                    "window_count": 0,
                    "windows": [],
                },
            )
            entry["window_count"] += 1
            entry["windows"].append(str(c.get("title", "")))
        return list(apps.values())

    def focus_app(self, app: str, raise_window: bool = False) -> ActionResult:
        target = self._target_window(app)
        if not target:
            return ActionResult(
                ok=False, action="focus", message=f"no visible window matches {app!r}"
            )
        address = str(target.get("address", ""))
        ok, msg = self._dispatch(f'hl.dsp.focus({{window="{address}"}})')
        if not ok:
            # Fall back to the window's workspace, which surfaces it.
            ws = (target.get("workspace") or {}).get("id")
            if ws is not None:
                ok, msg = self._dispatch(f"hl.dsp.focus({{workspace={int(ws)}}})")
        return ActionResult(
            ok=ok,
            action="focus",
            message=(
                f"focused {target.get('class')} ({address})"
                if ok
                else f"focus failed: {msg}"
            ),
        )

    def set_value(self, value: str, element: Optional[int] = None) -> ActionResult:
        return ActionResult(
            ok=False,
            action="set_value",
            message=(
                "set_value needs the accessibility bridge (AT-SPI), which is "
                "X11-only in this driver. Focus the field and use type/click."
            ),
        )
