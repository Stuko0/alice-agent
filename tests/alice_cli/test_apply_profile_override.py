"""Regression tests for _apply_profile_override ALICE_HOME guard (issue #22502).

When ALICE_HOME is set to the alice root (e.g. systemd hardcodes
ALICE_HOME=/root/.alice), _apply_profile_override must still read
active_profile and update ALICE_HOME to the profile directory.

When ALICE_HOME is already a profile directory (.../profiles/<name>),
_apply_profile_override must trust it and return without re-reading
active_profile (child-process inheritance contract).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace



def _run_apply_profile_override(
    tmp_path, monkeypatch, *, lydia_home: str | None, active_profile: str | None,
    argv: list[str] | None = None,
):
    """Run _apply_profile_override in isolation.

    Returns the value of os.environ["ALICE_HOME"] after the call,
    or None if unset.
    """
    lydia_root = tmp_path / ".alice"
    lydia_root.mkdir(parents=True, exist_ok=True)

    if active_profile is not None:
        (lydia_root / "active_profile").write_text(active_profile)

    if active_profile and active_profile != "default":
        (lydia_root / "profiles" / active_profile).mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    if lydia_home is not None:
        monkeypatch.setenv("ALICE_HOME", lydia_home)
    else:
        monkeypatch.delenv("ALICE_HOME", raising=False)

    monkeypatch.setattr(sys, "argv", argv or ["alice", "gateway", "start"])

    from alice_cli.main import _apply_profile_override
    _apply_profile_override()

    return os.environ.get("ALICE_HOME")


class TestApplyProfileOverrideLydiaHomeGuard:
    """Regression guard for issue #22502.

    Verifies that ALICE_HOME pointing to the alice root does NOT suppress
    the active_profile check, while ALICE_HOME already pointing to a
    profile directory IS trusted as-is.
    """

    def test_lydia_home_at_root_with_active_profile_is_redirected(
        self, tmp_path, monkeypatch
    ):
        """ALICE_HOME=/root/.alice + active_profile=coder must redirect
        ALICE_HOME to .../profiles/coder.

        Bug scenario from #22502: systemd sets ALICE_HOME to the alice root
        and the user switches to a profile via `alice profile use`.
        Before the fix, the guard returned early and active_profile was ignored.
        """
        lydia_root = tmp_path / ".alice"
        lydia_root.mkdir(parents=True, exist_ok=True)

        result = _run_apply_profile_override(
            tmp_path,
            monkeypatch,
            lydia_home=str(lydia_root),
            active_profile="coder",
        )

        assert result is not None, "ALICE_HOME must be set after profile redirect"
        assert "profiles" in result, (
            f"Expected ALICE_HOME to point into profiles/ dir, got: {result!r}"
        )
        assert result.endswith("coder"), (
            f"Expected ALICE_HOME to end with 'coder', got: {result!r}"
        )

    def test_lydia_home_already_profile_dir_is_trusted(self, tmp_path, monkeypatch):
        """ALICE_HOME=.../profiles/coder must not be overridden even when
        active_profile says something different.

        Preserves the child-process inheritance contract: a subprocess spawned
        with ALICE_HOME already set to a specific profile must stay in that
        profile.
        """
        lydia_root = tmp_path / ".alice"
        profile_dir = lydia_root / "profiles" / "coder"
        profile_dir.mkdir(parents=True, exist_ok=True)

        (lydia_root / "active_profile").write_text("other")

        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.setenv("ALICE_HOME", str(profile_dir))
        monkeypatch.setattr(sys, "argv", ["alice", "gateway", "start"])

        from alice_cli.main import _apply_profile_override
        _apply_profile_override()

        assert os.environ.get("ALICE_HOME") == str(profile_dir), (
            "ALICE_HOME must remain unchanged when already pointing to a profile dir"
        )

    def test_lydia_home_unset_reads_active_profile(self, tmp_path, monkeypatch):
        """Classic case: ALICE_HOME unset + active_profile=coder must set
        ALICE_HOME to the profile directory (existing behaviour must not regress).
        """
        result = _run_apply_profile_override(
            tmp_path,
            monkeypatch,
            lydia_home=None,
            active_profile="coder",
        )

        assert result is not None
        assert "coder" in result

    def test_sudo_explicit_profile_resolves_invoking_users_profile(self, tmp_path, monkeypatch):
        """sudo elias ... should resolve `-p elias` under SUDO_USER, not root."""
        root_home = tmp_path / "root"
        user_home = tmp_path / "home" / "alice"
        profile_dir = user_home / ".alice" / "profiles" / "elias"
        profile_dir.mkdir(parents=True, exist_ok=True)
        (root_home / ".alice").mkdir(parents=True, exist_ok=True)

        monkeypatch.setattr(Path, "home", lambda: root_home)
        monkeypatch.setenv("SUDO_USER", "alice")
        monkeypatch.delenv("ALICE_HOME", raising=False)
        monkeypatch.setattr(os, "geteuid", lambda: 0, raising=False)
        monkeypatch.setattr(sys, "argv", ["alice", "-p", "elias", "gateway", "install", "--system"])

        import pwd

        monkeypatch.setattr(pwd, "getpwnam", lambda name: SimpleNamespace(pw_dir=str(user_home)))

        from alice_cli.main import _apply_profile_override
        _apply_profile_override()

        assert os.environ.get("ALICE_HOME") == str(profile_dir)
        assert sys.argv == ["alice", "gateway", "install", "--system"]

    def test_lydia_home_unset_default_profile_no_redirect(self, tmp_path, monkeypatch):
        """active_profile=default must not redirect ALICE_HOME."""
        lydia_root = tmp_path / ".alice"
        lydia_root.mkdir(parents=True, exist_ok=True)

        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.delenv("ALICE_HOME", raising=False)
        monkeypatch.setattr(sys, "argv", ["alice", "gateway", "start"])
        (lydia_root / "active_profile").write_text("default")

        from alice_cli.main import _apply_profile_override
        _apply_profile_override()

        assert os.environ.get("ALICE_HOME") is None

    def test_subcommand_profile_flag_is_not_consumed(self, tmp_path, monkeypatch):
        """Command argv flags named --profile must stay with that command.

        Docker Desktop's MCP Toolkit uses `docker mcp gateway run --profile ...`.
        When that argv is passed through `alice mcp add --args`, the early
        profile pre-parser must not interpret the Docker profile as a Alice
        profile.
        """
        lydia_root = tmp_path / ".alice"
        lydia_root.mkdir(parents=True, exist_ok=True)
        argv = [
            "alice",
            "mcp",
            "add",
            "docker-research",
            "--command",
            "docker",
            "--args",
            "mcp",
            "gateway",
            "run",
            "--profile",
            "research",
        ]

        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.delenv("ALICE_HOME", raising=False)
        monkeypatch.setattr(sys, "argv", list(argv))

        from alice_cli.main import _apply_profile_override
        _apply_profile_override()

        assert os.environ.get("ALICE_HOME") is None
        assert sys.argv == argv

    def test_profile_after_chat_subcommand_is_still_consumed(self, tmp_path, monkeypatch):
        """Profile flags historically work after normal Alice subcommands."""
        result = _run_apply_profile_override(
            tmp_path,
            monkeypatch,
            lydia_home=None,
            active_profile="coder",
            argv=["alice", "chat", "-p", "coder", "-q", "hello"],
        )

        assert result is not None
        assert result.endswith("coder")
        assert sys.argv == ["alice", "chat", "-q", "hello"]

    def test_top_level_profile_after_value_flag_is_consumed(self, tmp_path, monkeypatch):
        """Top-level --profile still works after other top-level value flags."""
        result = _run_apply_profile_override(
            tmp_path,
            monkeypatch,
            lydia_home=None,
            active_profile="coder",
            argv=["alice", "-m", "gpt-5", "--profile", "coder", "chat"],
        )

        assert result is not None
        assert result.endswith("coder")
        assert sys.argv == ["alice", "-m", "gpt-5", "chat"]

    def test_top_level_profile_after_continue_flag_is_consumed(self, tmp_path, monkeypatch):
        """--continue has an optional value, so a following --profile is a flag."""
        result = _run_apply_profile_override(
            tmp_path,
            monkeypatch,
            lydia_home=None,
            active_profile="coder",
            argv=["alice", "--continue", "--profile", "coder"],
        )

        assert result is not None
        assert result.endswith("coder")
        assert sys.argv == ["alice", "--continue"]


class TestSupervisedChildIgnoresStickyProfile:
    """The reserved default gateway s6 slot must not follow active_profile.

    Inside the Docker s6 image the ``gateway-default`` service slot runs a
    bare ``alice gateway run`` (no ``-p``) to mean "the root ALICE_HOME
    profile". The run-script exports ``LYDIA_S6_SUPERVISED_CHILD=1``.
    Without a guard, ``_apply_profile_override`` would read the sticky
    ``active_profile`` file (set by e.g. the dashboard profile switcher) and
    redirect the reserved default gateway into that profile — producing a
    duplicate gateway for the active profile and no real default gateway.
    """

    def test_supervised_child_does_not_follow_active_profile(
        self, tmp_path, monkeypatch
    ):
        """LYDIA_S6_SUPERVISED_CHILD + active_profile=briefer must NOT redirect.

        Reproduces the Docker/profile scoping bug: the supervised default
        gateway is launched as bare ``alice gateway run`` with
        ALICE_HOME=/opt/data (the container root, whose parent is NOT
        ``profiles``), and a sticky ``active_profile`` of another profile.
        The reserved default slot must stay on the root profile.
        """
        lydia_root = tmp_path / ".alice"
        lydia_root.mkdir(parents=True, exist_ok=True)
        (lydia_root / "active_profile").write_text("briefer")
        (lydia_root / "profiles" / "briefer").mkdir(parents=True, exist_ok=True)

        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        # Container root ALICE_HOME: parent dir is NOT "profiles", so the
        # #22502 guard does not short-circuit — step 2 (active_profile) runs.
        monkeypatch.setenv("ALICE_HOME", str(lydia_root))
        monkeypatch.setenv("LYDIA_S6_SUPERVISED_CHILD", "1")
        monkeypatch.setattr(sys, "argv", ["alice", "gateway", "run"])

        from alice_cli.main import _apply_profile_override
        _apply_profile_override()

        assert os.environ.get("ALICE_HOME") == str(lydia_root), (
            "Supervised default gateway must stay on the root profile, not be "
            f"hijacked by active_profile; got {os.environ.get('ALICE_HOME')!r}"
        )

    def test_non_supervised_run_still_follows_active_profile(
        self, tmp_path, monkeypatch
    ):
        """Without the sentinel, a normal `alice gateway run` still honors
        active_profile — the guard is scoped strictly to supervised children."""
        result = _run_apply_profile_override(
            tmp_path,
            monkeypatch,
            lydia_home=None,
            active_profile="briefer",
            argv=["alice", "gateway", "run"],
        )

        assert result is not None
        assert result.endswith("briefer")

    def test_supervised_named_profile_flag_still_wins(self, tmp_path, monkeypatch):
        """A supervised named-profile slot passes ``-p <name>`` explicitly;
        that must still resolve (the sentinel guard only skips the sticky
        active_profile fallback, never an explicit flag)."""
        lydia_root = tmp_path / ".alice"
        lydia_root.mkdir(parents=True, exist_ok=True)
        (lydia_root / "active_profile").write_text("briefer")
        (lydia_root / "profiles" / "briefer").mkdir(parents=True, exist_ok=True)
        (lydia_root / "profiles" / "coder").mkdir(parents=True, exist_ok=True)

        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.delenv("ALICE_HOME", raising=False)
        monkeypatch.setenv("LYDIA_S6_SUPERVISED_CHILD", "1")
        monkeypatch.setattr(sys, "argv", ["alice", "-p", "coder", "gateway", "run"])

        from alice_cli.main import _apply_profile_override
        _apply_profile_override()

        result = os.environ.get("ALICE_HOME")
        assert result is not None
        assert result.endswith("coder")

