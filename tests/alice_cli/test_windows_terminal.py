"""Tests for alice_cli.windows_terminal — WSL2 detection and Windows shell
defaults for the setup wizard's terminal-backend step."""

from unittest.mock import MagicMock

import pytest

from alice_cli import windows_terminal as wt


class TestDetectWsl:
    def test_false_on_non_windows(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", False)
        assert wt.detect_wsl() is False

    def test_false_when_wsl_binary_missing(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", True)
        monkeypatch.setattr(wt.shutil, "which", lambda _n: None)
        assert wt.detect_wsl() is False

    def test_true_when_wsl_lists_distro(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", True)
        monkeypatch.setattr(wt.shutil, "which", lambda _n: "C:/Windows/System32/wsl.exe")
        mock_run = MagicMock(return_value=MagicMock(returncode=0, stdout="Ubuntu\n"))
        monkeypatch.setattr(wt.subprocess, "run", mock_run)
        assert wt.detect_wsl() is True

    def test_false_when_no_distros(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", True)
        monkeypatch.setattr(wt.shutil, "which", lambda _n: "C:/Windows/System32/wsl.exe")
        mock_run = MagicMock(return_value=MagicMock(returncode=0, stdout="  \n"))
        monkeypatch.setattr(wt.subprocess, "run", mock_run)
        assert wt.detect_wsl() is False

    def test_false_on_wsl_failure(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", True)
        monkeypatch.setattr(wt.shutil, "which", lambda _n: "C:/Windows/System32/wsl.exe")
        mock_run = MagicMock(return_value=MagicMock(returncode=1, stdout=""))
        monkeypatch.setattr(wt.subprocess, "run", mock_run)
        assert wt.detect_wsl() is False

    def test_false_on_timeout_or_oserror(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", True)
        monkeypatch.setattr(wt.shutil, "which", lambda _n: "C:/Windows/System32/wsl.exe")

        def _boom(*_a, **_kw):
            raise OSError("wsl exploded")

        monkeypatch.setattr(wt.subprocess, "run", _boom)
        assert wt.detect_wsl() is False


class TestRecommendedBackend:
    def test_wsl_recommended_on_windows_with_wsl(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", True)
        monkeypatch.setattr(wt, "detect_wsl", lambda: True)
        assert wt.recommended_backend() == "wsl"

    def test_local_recommended_on_windows_without_wsl(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", True)
        monkeypatch.setattr(wt, "detect_wsl", lambda: False)
        assert wt.recommended_backend() == "local"

    def test_local_recommended_off_windows(self, monkeypatch):
        monkeypatch.setattr(wt, "IS_WINDOWS", False)
        assert wt.recommended_backend() == "local"
