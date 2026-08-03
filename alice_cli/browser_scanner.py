"""Browser scanner — detect installed browsers on the system.

Used by ``alice setup`` to let the user choose which browser Alice should
open rendered web pages in.  Scans:

- PATH (via ``shutil.which``)
- Flatpak (``flatpak list --app``)
- Snap (``/snap/bin/``)

Supports Linux, macOS and Windows.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import sys

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Browser definitions
# ---------------------------------------------------------------------------
# (name, [executable_names...])
# The first executable found wins for that browser.
LINUX_BROWSERS: list[tuple[str, list[str]]] = [
    ("Brave", ["brave", "brave-browser"]),
    ("Chrome", ["google-chrome", "google-chrome-stable"]),
    ("Chromium", ["chromium", "chromium-browser"]),
    ("Firefox", ["firefox"]),
    ("Edge", ["microsoft-edge", "microsoft-edge-stable"]),
    ("Opera", ["opera"]),
    ("Vivaldi", ["vivaldi"]),
    ("Zen Browser", ["zen-browser", "zen"]),
    ("Floorp", ["floorp"]),
    ("Tor Browser", ["torbrowser", "tor-browser"]),
]

# Flatpak IDs for browsers (in priority order, subset of LINUX_BROWSERS)
LINUX_FLATPAKS: list[tuple[str, str]] = [
    ("Brave", "com.brave.Browser"),
    ("Chrome", "com.google.Chrome"),
    ("Chromium", "org.chromium.Chromium"),
    ("Firefox", "org.mozilla.firefox"),
    ("Edge", "com.microsoft.Edge"),
    ("Opera", "com.opera.Opera"),
    ("Vivaldi", "com.vivaldi.Vivaldi"),
    ("Zen Browser", "io.github.zen_browser.zen"),
]

# Snap package names
LINUX_SNAPS: list[tuple[str, str]] = [
    ("Brave", "brave"),
    ("Chromium", "chromium"),
    ("Firefox", "firefox"),
]

MACOS_BROWSERS: list[tuple[str, list[str]]] = [
    ("Safari", ["safari"]),
    ("Chrome", ["google-chrome"]),
    ("Firefox", ["firefox"]),
    ("Brave", ["brave"]),
    ("Edge", ["microsoft-edge"]),
    ("Opera", ["opera"]),
    ("Arc", ["arc"]),
    ("Vivaldi", ["vivaldi"]),
    ("Orion", ["orion"]),
]

WINDOWS_BROWSERS: list[tuple[str, list[str]]] = [
    ("Edge", ["msedge", "msedge.exe"]),
    ("Chrome", ["chrome", "chrome.exe"]),
    ("Firefox", ["firefox", "firefox.exe"]),
    ("Brave", ["brave", "brave.exe"]),
    ("Opera", ["opera", "launcher.exe"]),
    ("Vivaldi", ["vivaldi", "vivaldi.exe"]),
]

# Common install paths for Windows (Program Files, LOCALAPPDATA)
WINDOWS_PATHS: list[str] = [
    os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application"),
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application"),
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application"),
    os.path.expandvars(r"%PROGRAMFILES%\BraveSoftware\Brave-Browser\Application"),
    os.path.expandvars(r"%PROGRAMFILES%\Google\Chrome\Application"),
    os.path.expandvars(r"%PROGRAMFILES(x86)%\Google\Chrome\Application"),
    os.path.expandvars(r"%PROGRAMFILES%\Microsoft\Edge\Application"),
    os.path.expandvars(r"%PROGRAMFILES(x86)%\Microsoft\Edge\Application"),
    os.path.expandvars(r"%PROGRAMFILES%\Mozilla Firefox"),
    os.path.expandvars(r"%PROGRAMFILES(x86)%\Mozilla Firefox"),
    os.path.expandvars(r"%PROGRAMFILES%\Opera"),
    os.path.expandvars(r"%PROGRAMFILES%\Vivaldi"),
]


# ---------------------------------------------------------------------------
# Browser result
# ---------------------------------------------------------------------------
class BrowserInfo:
    """Describes an installed browser."""

    def __init__(self, name: str, command: str, source: str = "path") -> None:
        self.name = name
        self.command = command  # executable path or wrapped command (e.g. "flatpak run ...")
        self.source = source  # "path" | "flatpak" | "snap" | "mac_app"

    def __repr__(self) -> str:
        return f"BrowserInfo({self.name}, {self.command}, source={self.source})"


# ---------------------------------------------------------------------------
# Scanner
# ---------------------------------------------------------------------------
def _check_flatpak() -> list[BrowserInfo]:
    """Scan Flatpak for installed browsers."""
    results: list[BrowserInfo] = []
    try:
        result = subprocess.run(
            ["flatpak", "list", "--app", "--columns=application"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return results

        installed_ids = set(line.strip() for line in result.stdout.splitlines() if line.strip())

        for name, flatpak_id in LINUX_FLATPAKS:
            if flatpak_id in installed_ids:
                results.append(BrowserInfo(name, f"flatpak run {flatpak_id}", source="flatpak"))
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return results


def _check_snap() -> list[BrowserInfo]:
    """Scan Snap for installed browsers."""
    results: list[BrowserInfo] = []
    try:
        result = subprocess.run(
            ["snap", "list"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return results

        installed = set()
        for line in result.stdout.splitlines()[1:]:  # skip header
            parts = line.split()
            if parts:
                installed.add(parts[0])

        for name, snap_name in LINUX_SNAPS:
            if snap_name in installed:
                snap_path = f"/snap/bin/{snap_name}"
                if os.path.isfile(snap_path):
                    results.append(BrowserInfo(name, snap_path, source="snap"))
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return results


def _check_windows_paths() -> list[BrowserInfo]:
    """Check common Windows install paths for browser executables."""
    results: list[BrowserInfo] = []
    for browser_name, executables in WINDOWS_BROWSERS:
        for exe in executables:
            # Check PATH first
            path = shutil.which(exe)
            if path:
                results.append(BrowserInfo(browser_name, path, source="path"))
                break
            # Check known install directories
            for install_dir in WINDOWS_PATHS:
                candidate = os.path.join(install_dir, exe)
                if os.path.isfile(candidate):
                    results.append(BrowserInfo(browser_name, candidate, source="path"))
                    break
            else:
                continue
            break
    return results


def _check_macos_apps() -> list[BrowserInfo]:
    """Check macOS /Applications for browsers."""
    results: list[BrowserInfo] = []
    apps_dir = "/Applications"
    user_apps_dir = os.path.expanduser("~/Applications")

    for browser_name, executables in MACOS_BROWSERS:
        # Check PATH first (for Homebrew-installed browsers)
        path = shutil.which(executables[0])
        if path:
            results.append(BrowserInfo(browser_name, path, source="path"))
            continue
        # Check /Applications
        app_path = os.path.join(apps_dir, f"{browser_name}.app")
        if not os.path.isdir(app_path):
            app_path = os.path.join(user_apps_dir, f"{browser_name}.app")
        if os.path.isdir(app_path):
            # Use the open command with the app bundle
            results.append(BrowserInfo(browser_name, f"open -a '{browser_name}'", source="mac_app"))

    return results


def _check_path() -> list[BrowserInfo]:
    """Scan PATH for browser executables."""
    results: list[BrowserInfo] = []
    system = platform.system()

    if system == "Windows":
        browser_list = WINDOWS_BROWSERS
    elif system == "Darwin":
        browser_list = MACOS_BROWSERS
    else:
        browser_list = LINUX_BROWSERS

    for browser_name, executables in browser_list:
        for exe in executables:
            path = shutil.which(exe)
            if path:
                results.append(BrowserInfo(browser_name, path, source="path"))
                break

    return results


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def scan_browsers() -> list[BrowserInfo]:
    """Return a deduplicated list of installed browsers.

    Scans PATH, Flatpak, Snap (Linux), /Applications (macOS),
    and common install directories (Windows).
    First occurrence of each browser name wins.
    """
    seen: set[str] = set()
    results: list[BrowserInfo] = []

    system = platform.system()

    def _add(browsers: list[BrowserInfo]) -> None:
        for b in browsers:
            key = b.name.lower()
            if key not in seen:
                seen.add(key)
                results.append(b)

    if system == "Windows":
        # Windows: PATH + common install dirs
        _add(_check_path())
        _add(_check_windows_paths())
    elif system == "Darwin":
        # macOS: PATH + /Applications
        _add(_check_path())
        _add(_check_macos_apps())
    else:
        # Linux: PATH + Flatpak + Snap
        _add(_check_path())
        _add(_check_flatpak())
        _add(_check_snap())

    return results


def get_system_default_browser() -> str | None:
    """Return the command/path for the system's default browser, if detectable.

    Uses ``xdg-settings`` on Linux and ``webbrowser`` on all platforms.
    """
    system = platform.system()
    if system == "Linux":
        try:
            result = subprocess.run(
                ["xdg-settings", "get", "default-web-browser"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                desktop_file = result.stdout.strip()
                # Map .desktop file to browser name
                desktop_to_browser = {
                    "brave-browser.desktop": "Brave",
                    "google-chrome.desktop": "Chrome",
                    "chromium-browser.desktop": "Chromium",
                    "chromium.desktop": "Chromium",
                    "firefox.desktop": "Firefox",
                    "microsoft-edge.desktop": "Edge",
                    "opera.desktop": "Opera",
                    "vivaldi.desktop": "Vivaldi",
                }
                browser_name = desktop_to_browser.get(desktop_file)
                if browser_name:
                    return browser_name
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            pass

    # Fallback: use the first browser from scan
    browsers = scan_browsers()
    if browsers:
        return browsers[0].command

    return None


def open_url(url: str, browser_command: str | None = None) -> bool:
    """Open a URL in the specified browser, or the system default.

    Args:
        url: The URL to open.
        browser_command: The browser command/path (e.g. ``"brave"``,
            ``"flatpak run com.brave.Browser"``, ``"/usr/bin/firefox"``).
            If None, uses Python's ``webbrowser.open``.

    Returns:
        True if the URL was opened successfully, False otherwise.
    """
    if not browser_command:
        import webbrowser

        webbrowser.open(url)
        return True

    try:
        subprocess.Popen(
            [*browser_command.split(), url],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except FileNotFoundError:
        logger.warning("Browser command not found: %s — falling back to system default", browser_command)
        import webbrowser

        webbrowser.open(url)
        return True
    except OSError as exc:
        logger.warning("Failed to open browser %s: %s — falling back to system default", browser_command, exc)
        import webbrowser

        webbrowser.open(url)
        return True
