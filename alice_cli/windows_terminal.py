"""Windows terminal-backend helpers for the setup wizard.

Detected once at import-wizard time, not at module import, so tests can
monkeypatch ``IS_WINDOWS``/``shutil.which``/``subprocess.run`` freely.

The wizard's recommended default on Windows with WSL2 installed is the
``wsl`` backend: it gives the agent a POSIX shell without asking the user
to install Docker Desktop (which the ``docker`` backend would require).
"""

from __future__ import annotations

import shutil
import subprocess

from alice_cli._subprocess_compat import IS_WINDOWS

# Win32 CREATE_NO_WINDOW. Duplicated from _subprocess_compat.windows_hide_flags
# because that helper is intentionally not re-exported at import time on
# non-Windows (a `if IS_WINDOWS` guard), and the wizard needs to *name* the
# constant without tripping an AttributeError. 0 elsewhere keeps POSIX happy.
_WINDOWS_HIDE_FLAGS = 0x08000000 if IS_WINDOWS else 0


def detect_wsl() -> bool:
    """True when a WSL2 distro is installed and invocable.

    Only meaningful on Windows; always False elsewhere. Swallows every
    failure mode (missing binary, non-zero exit, timeout, OSError) and
    degrades to False — the wizard treats undetectable as "not present".
    """
    if not IS_WINDOWS:
        return False
    if not shutil.which("wsl"):
        return False
    try:
        proc = subprocess.run(
            ["wsl", "-l", "-q"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=_WINDOWS_HIDE_FLAGS,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if proc.returncode != 0:
        return False
    return bool(proc.stdout.strip())


def recommended_backend() -> str:
    """Terminal backend the wizard pre-selects for this machine."""
    if IS_WINDOWS and detect_wsl():
        return "wsl"
    return "local"
