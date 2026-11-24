"""`alice desktop` must find the Wails CLI installed by `go install`.

`go install` drops the binary in $(go env GOPATH)/bin, which is frequently not
on PATH (a fresh shell, a launcher, the desktop's own update path). Shelling out
to a bare `wails` died with FileNotFoundError on correctly installed machines.
"""

from pathlib import Path
import os
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from alice_cli import main as alice_main  # noqa: E402


def _fake_wails(dirpath: Path) -> Path:
    dirpath.mkdir(parents=True, exist_ok=True)
    exe = dirpath / "wails"
    exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    exe.chmod(0o755)

    return exe


@pytest.fixture(autouse=True)
def _no_ambient_wails(monkeypatch, tmp_path):
    """Keep the host's own install from deciding these tests."""
    monkeypatch.setattr(alice_main.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("WAILS_BIN", raising=False)
    monkeypatch.delenv("GOBIN", raising=False)
    monkeypatch.delenv("GOPATH", raising=False)
    monkeypatch.setattr(alice_main.shutil, "which", lambda _name: None)  # type: ignore[attr-defined]
    monkeypatch.setattr(alice_main, "_go_env_path", lambda _name: "")


def test_explicit_override_wins(tmp_path, monkeypatch):
    exe = _fake_wails(tmp_path / "bin")
    monkeypatch.setenv("WAILS_BIN", str(exe))

    assert alice_main.resolve_wails_binary() == str(exe)


def test_falls_back_to_the_go_bin_dir(tmp_path, monkeypatch):
    exe = _fake_wails(tmp_path / "gopath" / "bin")
    monkeypatch.setenv("GOPATH", str(tmp_path / "gopath"))

    assert alice_main.resolve_wails_binary() == str(exe)


def test_reads_gopath_from_go_env_when_unset(tmp_path, monkeypatch):
    exe = _fake_wails(tmp_path / "gopath" / "bin")
    monkeypatch.setattr(alice_main, "_go_env_path", lambda name: str(tmp_path / "gopath") if name == "GOPATH" else "")

    assert alice_main.resolve_wails_binary() == str(exe)


def test_falls_back_to_home_go_bin(tmp_path, monkeypatch):
    exe = _fake_wails(tmp_path / "go" / "bin")
    monkeypatch.setattr(alice_main.Path, "home", staticmethod(lambda: tmp_path))

    assert alice_main.resolve_wails_binary() == str(exe)


def test_returns_none_when_absent(monkeypatch, tmp_path):
    monkeypatch.setattr(alice_main.Path, "home", staticmethod(lambda: tmp_path))

    assert alice_main.resolve_wails_binary() is None


def test_installs_once_when_go_is_available(tmp_path, monkeypatch):
    bindir = tmp_path / "gopath" / "bin"
    monkeypatch.setenv("GOPATH", str(tmp_path / "gopath"))
    monkeypatch.setattr(alice_main.shutil, "which", lambda name: "/usr/bin/go" if name == "go" else None)  # type: ignore[attr-defined]

    calls = []

    class Done:
        returncode = 0

    def fake_run(argv, **_kwargs):
        calls.append(argv)
        _fake_wails(bindir)  # `go install` drops the binary here
        return Done()

    monkeypatch.setattr(alice_main.subprocess, "run", fake_run)

    assert alice_main.ensure_wails_binary() == str(bindir / "wails")
    assert calls and calls[0][:2] == ["go", "install"]
    assert "github.com/wailsapp/wails/v2/cmd/wails@v" in calls[0][2]


def test_build_uses_the_resolved_binary(tmp_path, monkeypatch):
    desktop_dir = tmp_path / "desktop"
    wails_dir = tmp_path / "wails"
    (desktop_dir / "dist").mkdir(parents=True)
    (desktop_dir / "dist" / "index.html").write_text("<html></html>", encoding="utf-8")
    (wails_dir / "frontend").mkdir(parents=True)

    calls = []

    class Done:
        returncode = 0

    monkeypatch.setattr(alice_main, "ensure_wails_binary", lambda: "/opt/go/bin/wails")
    monkeypatch.setattr(alice_main.subprocess, "run", lambda argv, **kw: calls.append((argv, kw)) or Done())

    alice_main._build_wails_desktop("npm", desktop_dir, wails_dir)

    build_calls = [argv for argv, _kw in calls if argv[0] != "npm"]
    assert build_calls and build_calls[0][0] == "/opt/go/bin/wails"
    assert build_calls[0][1:] == ["build"]
