"""The desktop dependency install must be idempotent and survive npm races.

`alice desktop` used to run `npm ci` on every source edit (the build stamp only
tracked sources), which is slow and occasionally dies with
`ENOTEMPTY: directory not empty` when npm's cleanup races another process —
aborting a rebuild whose dependencies were already correct.
"""

from pathlib import Path
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from alice_cli import main as alice_main  # noqa: E402


def _root(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "apps" / "desktop").mkdir(parents=True)
    (root / "package.json").write_text('{"name":"alice","workspaces":["apps/*"]}', encoding="utf-8")
    (root / "package-lock.json").write_text('{"lockfileVersion": 3}', encoding="utf-8")
    (root / "apps" / "desktop" / "package.json").write_text('{"name":"desktop"}', encoding="utf-8")

    return root


def _done(code: int, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=stdout, stderr=stderr)


def test_hash_tracks_the_lockfile(tmp_path):
    root = _root(tmp_path)
    before = alice_main._desktop_deps_hash(root)

    (root / "package-lock.json").write_text('{"lockfileVersion": 3, "packages": {}}', encoding="utf-8")

    assert alice_main._desktop_deps_hash(root) != before


def test_skips_when_the_tree_is_current(tmp_path, monkeypatch):
    root = _root(tmp_path)
    (root / "node_modules").mkdir()
    (root / "node_modules" / ".alice-deps-hash").write_text(alice_main._desktop_deps_hash(root), encoding="utf-8")

    def boom(*_a, **_kw):
        raise AssertionError("npm must not run when the deps hash matches")

    monkeypatch.setattr(alice_main, "_run_npm_install_deterministic", boom)

    assert alice_main._install_desktop_deps("npm", root).returncode == 0


def test_installs_and_records_the_hash(tmp_path, monkeypatch):
    root = _root(tmp_path)
    calls = []

    def fake(npm, cwd, **_kw):
        calls.append(cwd)
        return _done(0, "added 1200 packages\n")

    monkeypatch.setattr(alice_main, "_run_npm_install_deterministic", fake)

    assert alice_main._install_desktop_deps("npm", root).returncode == 0
    assert calls == [root]
    assert (root / "node_modules" / ".alice-deps-hash").read_text(encoding="utf-8") == alice_main._desktop_deps_hash(root)


def test_enotempty_cleans_the_tree_and_retries(tmp_path, monkeypatch):
    root = _root(tmp_path)
    (root / "node_modules" / "leftover").mkdir(parents=True)
    (root / "apps" / "desktop" / "node_modules").mkdir(parents=True)

    results = iter([
        _done(1, "", "npm error code ENOTEMPTY\nnpm error rmdir '…/node_modules/es-toolkit/compat'"),
        _done(0, "added 1200 packages\n")
    ])
    attempts = []

    def fake(npm, cwd, **_kw):
        attempts.append(sorted(p.name for p in (root / "node_modules").iterdir()) if (root / "node_modules").exists() else [])
        return next(results)

    monkeypatch.setattr(alice_main, "_run_npm_install_deterministic", fake)

    assert alice_main._install_desktop_deps("npm", root).returncode == 0
    assert len(attempts) == 2
    # The first attempt saw the stale tree; the retry ran against a clean one.
    assert attempts[0] == ["leftover"]
    assert not (root / "apps" / "desktop" / "node_modules").exists()
    assert (root / "node_modules" / ".alice-deps-hash").is_file()


def test_plain_failure_does_not_touch_the_tree(tmp_path, monkeypatch):
    root = _root(tmp_path)
    (root / "node_modules" / "keep").mkdir(parents=True)

    monkeypatch.setattr(
        alice_main,
        "_run_npm_install_deterministic",
        lambda *_a, **_kw: _done(1, "", "npm error network request failed"),
    )

    assert alice_main._install_desktop_deps("npm", root).returncode == 1
    assert (root / "node_modules" / "keep").is_dir()
    assert not (root / "node_modules" / ".alice-deps-hash").exists()
