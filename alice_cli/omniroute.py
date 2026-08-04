"""OmniRoute free-gateway lifecycle for the thin-client provider path.

Alice does NOT vendor OmniRoute (AGENTS.md: third-party products stay out of
the core tree). Instead we treat it as a managed local service:
``available()`` decides how to launch it (npx if Node ≥22 exists, Docker
otherwise), ``ensure_running()`` spawns the gateway on first need and reuses
an already-healthy instance, and ``base_url_for()`` returns the
OpenAI-compatible endpoint the provider layer points at.

The provider itself is plain ``custom``: ``base_url`` + a locally-minted
token. No new catalog surface, no plugin in the repo, no Copilot CLI.
"""

from __future__ import annotations

import json
import logging
import secrets
import shutil
import subprocess
import time
import urllib.request
from typing import Optional

from alice_cli._subprocess_compat import IS_WINDOWS

_log = logging.getLogger(__name__)

_DEFAULT_PORT = 4319
_OMNIROUTE_DOCKER_IMAGE = "diegosouzapw/omniroute:release-v3.8.50"
_OMNIROUTE_NPM_SPEC = "omniroute@3.8.50"
_HEALTH_TIMEOUT_S = 30.0
_HEALTH_POLL_S = 0.5
_WINDOWS_HIDE = 0x08000000 if IS_WINDOWS else 0  # CREATE_NO_WINDOW


def available() -> Optional[str]:
    """Which launcher can bring OmniRoute up on this box: 'npx' | 'docker' | None."""
    if shutil.which("npx"):
        return "npx"
    if shutil.which("docker"):
        return "docker"
    return None


def base_url_for(port: int = _DEFAULT_PORT) -> str:
    return f"http://127.0.0.1:{port}/v1"


def _health_ok(base_url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(f"{base_url}/models", timeout=timeout) as resp:
            return resp.status < 500
    except Exception:
        return False


def _wait_for_health(base_url: str, timeout: float = _HEALTH_TIMEOUT_S) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _health_ok(base_url):
            return True
        time.sleep(_HEALTH_POLL_S)
    return False


def ensure_running(port: int = _DEFAULT_PORT) -> Optional[subprocess.Popen]:
    """Bring OmniRoute up if not already healthy; return its Popen on first
    spawn, None when an existing healthy instance was reused.

    Raises RuntimeError when neither npx nor Docker is available — the caller
    surfaces this to the user and falls back to a non-managed provider path.
    """
    base = base_url_for(port)
    if _health_ok(base):
        _log.debug("omniroute: reusing healthy instance at %s", base)
        return None

    launcher = available()
    if launcher is None:
        raise RuntimeError(
            "OmniRoute needs neither npx nor docker — install Node 22+ or "
            "Docker, or pick a different provider. See https://omniroute.online"
        )

    if launcher == "npx":
        argv = ["npx", "--yes", _OMNIROUTE_NPM_SPEC, "start", "--port", str(port)]
    else:  # docker
        argv = [
            "docker", "run", "-d", "--rm",
            "-p", f"{port}:4319",
            "--name", f"alice-omniroute-{port}",
            _OMNIROUTE_DOCKER_IMAGE,
        ]

    _log.info("omniroute: spawning via %s: %s", launcher, " ".join(argv))
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=_WINDOWS_HIDE,
    )

    if not _wait_for_health(base):
        try:
            proc.terminate()
        except Exception:
            pass
        raise RuntimeError(f"OmniRoute did not become healthy at {base} within {_HEALTH_TIMEOUT_S:.0f}s")

    return proc


def stop(port: int = _DEFAULT_PORT) -> None:
    """Best-effort shutdown; Docker path is the only one that needs it."""
    if shutil.which("docker"):
        subprocess.run(
            ["docker", "stop", f"alice-omniroute-{port}"],
            capture_output=True,
            creationflags=_WINDOWS_HIDE,
        )


def mint_local_token() -> str:
    """Local-only bearer for Alice→OmniRoute. Stays on disk in config.yaml;
    OmniRoute validates it is a syntactically bearer-shaped string but does
    not check it against an external authority on loopback."""
    return "omniroute-local-" + secrets.token_urlsafe(24)
