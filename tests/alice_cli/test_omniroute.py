"""Tests for alice_cli.omniroute — the managed free-gateway lifecycle the
quick setup drives. Mocked subprocess/HTTP so no Node install is required."""

from unittest.mock import MagicMock, patch

import pytest

from alice_cli import omniroute as omni


class TestDetect:
    def test_available_via_npx(self, monkeypatch):
        monkeypatch.setattr(omni.shutil, "which", lambda n: "/usr/bin/npx" if n == "npx" else None)
        assert omni.available() == "npx"

    def test_available_via_docker(self, monkeypatch):
        monkeypatch.setattr(omni.shutil, "which", lambda n: "/usr/bin/docker" if n == "docker" else None)
        assert omni.available() == "docker"

    def test_unavailable_when_neither(self, monkeypatch):
        monkeypatch.setattr(omni.shutil, "which", lambda _n: None)
        assert omni.available() is None


class TestSpawn:
    def test_spawn_via_npx_builds_expected_argv(self, monkeypatch):
        monkeypatch.setattr(omni, "available", lambda: "npx")
        popen = MagicMock()
        popen.returncode = None
        monkeypatch.setattr(omni.subprocess, "Popen", MagicMock(return_value=popen))
        monkeypatch.setattr(omni, "_wait_for_health", lambda *_a, **_kw: True)

        proc = omni.ensure_running(port=4319)
        assert proc is popen
        argv = omni.subprocess.Popen.call_args[0][0]
        assert "omniroute@" in argv[2], argv
        assert argv[-1] == "4319"

    def test_spawn_idempotent_when_already_healthy(self, monkeypatch):
        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: True)
        popen_mock = MagicMock()
        monkeypatch.setattr(omni.subprocess, "Popen", popen_mock)
        assert omni.ensure_running(port=4319) is None
        popen_mock.assert_not_called()

    def test_raises_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(omni, "available", lambda: None)
        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)
        with pytest.raises(RuntimeError, match="n[eo]ither npx nor docker"):
            omni.ensure_running(port=4319)


class TestBaseUrlFor:
    def test_url_format(self):
        assert omni.base_url_for(4319) == "http://127.0.0.1:4319/v1"
