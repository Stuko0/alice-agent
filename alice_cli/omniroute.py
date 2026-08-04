"""OmniRoute free-gateway lifecycle for the thin-client provider path.

Alice does NOT vendor OmniRoute (AGENTS.md: third-party products stay out of
the core tree). Instead we treat it as a managed local service:
``available()`` decides how to launch it (bundled → npx → docker, in that
order) and ``ensure_running()`` spawns the gateway on first need, reusing an
already-healthy instance and auto-provisioning a private Node.js + OmniRoute
into ``~/.alice/omniroute/`` when no system runtime exists.

The provider itself is plain ``custom``: ``base_url`` + a locally-minted
token. No new catalog surface, no plugin in the repo, no Copilot CLI.
"""

from __future__ import annotations

import hashlib
import json
import logging
import platform
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Optional

from alice_cli._subprocess_compat import IS_WINDOWS

_log = logging.getLogger(__name__)

_DEFAULT_PORT = 4319
_OMNIROUTE_DOCKER_IMAGE = "diegosouzapw/omniroute:release-v3.8.50"
_OMNIROUTE_NPM_SPEC = "omniroute@3.8.50"
_NODE_VERSION = "22.11.0"  # Node 22 LTS
_HEALTH_TIMEOUT_S = 30.0
_HEALTH_POLL_S = 0.5
_WINDOWS_HIDE = 0x08000000 if IS_WINDOWS else 0  # CREATE_NO_WINDOW

ProgressCB = Callable[[int], None]  # reports percentage 0-100


def bundled_root() -> Path:
    """`~/.alice/omniroute/` — where we stash the private Node + node_modules."""
    from alice_constants import get_alice_home
    return Path(get_alice_home()) / "omniroute"


def bundled_node() -> Optional[Path]:
    """Path to the bundled node binary once provisioned, else None."""
    root = bundled_root()
    bin_dir = root / ("bin" if not IS_WINDOWS else "")
    node = bin_dir / ("node.exe" if IS_WINDOWS else "node")
    if node.exists():
        return node
    return None


def omniroute_entry() -> Optional[Path]:
    """Path to OmniRoute's bin script inside the bundled node_modules."""
    p = bundled_root() / "node_modules" / "omniroute" / "bin" / "omniroute.mjs"
    return p if p.exists() else None


def _node_dist_url() -> tuple[str, str]:
    plat = sys.platform
    mach = platform.machine().lower()
    if plat == "darwin":
        m = "arm64" if mach in {"arm64", "aarch64"} else "x64"
        fname = f"node-v{_NODE_VERSION}-darwin-{m}.tar.gz"
    elif plat == "linux":
        m = "arm64" if mach in {"arm64", "aarch64"} else "x64"
        fname = f"node-v{_NODE_VERSION}-linux-{m}.tar.xz"
    elif plat == "win32":
        if mach not in {"amd64", "x86_64"}:
            raise RuntimeError(f"Unsupported Windows arch: {mach}")
        fname = f"node-v{_NODE_VERSION}-win-x64.zip"
    else:
        raise RuntimeError(f"Unsupported platform for bundled Node: {plat}")
    return f"https://nodejs.org/dist/v{_NODE_VERSION}/{fname}", fname


def _download_node(dest_dir: Path, on_progress: Optional[ProgressCB] = None) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    url, fname = _node_dist_url()
    archive = dest_dir / fname

    _log.info("omniroute: downloading %s", url)
    with urllib.request.urlopen(url, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        sha = hashlib.sha256()
        chunk = 1 << 16
        read = 0
        with open(archive, "wb") as fh:
            while True:
                buf = resp.read(chunk)
                if not buf:
                    break
                fh.write(buf)
                sha.update(buf)
                read += len(buf)
                if on_progress and total:
                    on_progress(int(read * 100 / total))

    # Verify against nodejs.org signed SHASUMS. Fail loud, don't attempt
    # to extract a corrupted/malicious download.
    shasums_url = f"https://nodejs.org/dist/v{_NODE_VERSION}/SHASUMS256.txt"
    with urllib.request.urlopen(shasums_url, timeout=30) as resp:
        shasums = resp.read().decode("utf-8", "replace")
    expected = None
    for line in shasums.splitlines():
        if line.rstrip().endswith(f"  {fname}"):
            expected = line.split()[0]
            break
    if expected is None:
        archive.unlink(missing_ok=True)
        raise RuntimeError(f"No checksum listed for {fname} in SHASUMS256.txt")
    got = sha.hexdigest()
    if got != expected:
        archive.unlink(missing_ok=True)
        raise RuntimeError(f"Node download checksum mismatch for {fname}: got {got}, want {expected}")

    return archive


def _extract_node() -> Path:
    """Extract the Node archive into bundled_root(), flattening the top dir."""
    root = bundled_root()
    url, fname = _node_dist_url()
    archive = root / fname
    _log.info("omniroute: extracting %s", archive)

    tmp = root / ".extract-tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    if fname.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(tmp)
    else:  # .tar.gz or .tar.xz — tarfile handles both
        with tarfile.open(archive) as tf:
            tf.extractall(tmp)

    inner = next(tmp.iterdir())
    for child in inner.iterdir():
        shutil.move(str(child), root / child.name)
    shutil.rmtree(tmp)
    archive.unlink(missing_ok=True)

    node = bundled_node()
    if not node:
        raise RuntimeError(f"Node extraction did not produce {node}")
    if not IS_WINDOWS:
        node.chmod(0o755)
    return node


def _npm_install_omniroute(on_progress: Optional[ProgressCB] = None) -> Path:
    root = bundled_root()
    node = bundled_node()
    if node is None:
        raise RuntimeError("cannot install OmniRoute: bundled node missing")

    npm_cli = root / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if not npm_cli.exists():
        raise RuntimeError(f"npm package layout unexpected; {npm_cli} missing")

    _log.info("omniroute: installing %s into %s", _OMNIROUTE_NPM_SPEC, root)
    argv = [str(node), str(npm_cli), "install", "--prefix", str(root), "--no-audit", "--no-fund", _OMNIROUTE_NPM_SPEC]
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=_WINDOWS_HIDE,
    )
    assert proc.stdout is not None
    for _line in proc.stdout:
        pass  # streaming; if we want progress later, parse the npm logs
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"npm install failed with exit {rc}; see ~/.alice/omniroute")

    entry = omniroute_entry()
    if entry is None:
        raise RuntimeError("npm install succeeded but omniroute bin missing")
    return entry


def provision_bundled(on_progress: Optional[ProgressCB] = None) -> Path:
    """Download Node 22 + ``npm install omniroute`` into ``~/.alice/omniroute/``.

    Idempotent: if the bundled node + omniroute entry already exist, skip the
    download and return the existing node path."""
    node = bundled_node()
    entry = omniroute_entry()
    if node and entry:
        _log.debug("omniroute: bundle already provisioned at %s", bundled_root())
        return node

    root = bundled_root()
    _download_node(root, on_progress)
    _extract_node()
    _npm_install_omniroute(on_progress)
    node = bundled_node()
    if node is None:
        raise RuntimeError("provisioning finished without producing a node binary")
    return node


def available() -> Optional[str]:
    """Which launcher can bring OmniRoute up: 'bundled' | 'npx' | 'docker' | None."""
    if bundled_node() and omniroute_entry():
        return "bundled"
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


def ensure_running(
    port: int = _DEFAULT_PORT,
    on_progress: Optional[ProgressCB] = None,
    *,
    allow_provision: bool = True,
) -> Optional[subprocess.Popen]:
    """Bring OmniRoute up if not already healthy; return its Popen on first
    spawn, None when an existing healthy instance was reused.

    Launch order: bundled node → npx → docker.  When none exist and
    ``allow_provision`` is true, download Node+OmniRoute into ~/.alice/ and
    run from there.

    Raises RuntimeError when we can't provision (no network, checksum
    failure, unsupported platform) — the caller surfaces this to the user.
    """
    base = base_url_for(port)
    if _health_ok(base):
        _log.debug("omniroute: reusing healthy instance at %s", base)
        return None

    launcher = available()
    if launcher is None:
        if not allow_provision:
            raise RuntimeError(
                "OmniRoute needs neither npx nor docker — install Node 22+ or "
                "Docker, or pick a different provider. See https://omniroute.online"
            )
        _log.info("omniroute: no system runtime; provisioning bundled copy")
        provision_bundled(on_progress=on_progress)
        launcher = available()
        if launcher != "bundled":
            raise RuntimeError("provisioning did not produce a usable bundle")

    if launcher == "bundled":
        argv = [str(bundled_node()), str(omniroute_entry()), "start", "--port", str(port)]
    elif launcher == "npx":
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
