"""Tests for alice_cli.omniroute — the managed free-gateway lifecycle the
quick setup drives. Mocked subprocess/HTTP so no Node install is required."""

from unittest.mock import MagicMock, patch

import pytest

from alice_cli import omniroute as omni


@pytest.fixture(autouse=True)
def _reset_active_base_urls():
    """The resolved loopback URL is process state; tests must not inherit it."""
    omni._ACTIVE_BASE_URLS.clear()
    yield
    omni._ACTIVE_BASE_URLS.clear()


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
        # Never let the reuse probe touch a real port: another process (or a
        # parallel test run) listening on 4319 would short-circuit the spawn.
        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)
        monkeypatch.setattr(omni, "available", lambda: "npx")
        popen = MagicMock()
        popen.returncode = None
        monkeypatch.setattr(omni.subprocess, "Popen", MagicMock(return_value=popen))
        monkeypatch.setattr(omni, "_wait_for_health", lambda *_a, **_kw: True)

        proc = omni.ensure_running(port=4319)
        assert proc is popen
        argv = omni.subprocess.Popen.call_args[0][0]
        assert "omniroute@" in argv[2], argv
        assert "serve" in argv, argv
        assert argv[argv.index("--port") + 1] == "4319"

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
            omni.ensure_running(port=4319, allow_provision=False)


    def test_falls_back_to_bundled_when_the_launcher_cannot_start(self, monkeypatch, tmp_path):
        """A broken npx on PATH must not dead-end the free-provider click."""
        bin_dir = tmp_path / ("." if omni.IS_WINDOWS else "bin")
        bin_dir.mkdir(parents=True, exist_ok=True)
        node = bin_dir / ("node.exe" if omni.IS_WINDOWS else "node")
        node.touch()
        entry = tmp_path / "node_modules" / "omniroute" / "bin" / "omniroute.mjs"
        entry.parent.mkdir(parents=True)
        entry.touch()
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)

        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)
        monkeypatch.setattr(omni, "available", lambda: "npx")
        monkeypatch.setattr(omni.shutil, "which", lambda n: "/usr/bin/npx" if n == "npx" else None)

        provisioned = []
        monkeypatch.setattr(omni, "provision_bundled", lambda **_kw: provisioned.append(True) or node)

        attempts = []

        def popen(argv, **_kwargs):
            attempts.append(argv)
            if len(attempts) == 1:
                raise FileNotFoundError("[WinError 2] The system cannot find the file specified")

            return MagicMock()

        monkeypatch.setattr(omni.subprocess, "Popen", popen)
        monkeypatch.setattr(omni, "_wait_for_health", lambda *_a, **_kw: True)

        proc = omni.ensure_running(port=4319)

        assert proc is not None
        assert provisioned == [True]
        assert len(attempts) == 2
        assert attempts[0][0].endswith("npx")
        assert attempts[1][0] == str(node)

    def test_launcher_start_error_is_readable_when_provisioning_is_off(self, monkeypatch):
        monkeypatch.setattr(omni, "available", lambda: "npx")
        monkeypatch.setattr(omni.shutil, "which", lambda n: "/usr/bin/npx" if n == "npx" else None)

        def popen(_argv, **_kwargs):
            raise FileNotFoundError("[WinError 2] npx")

        monkeypatch.setattr(omni.subprocess, "Popen", popen)
        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)

        with pytest.raises(RuntimeError, match="Could not start OmniRoute via npx"):
            omni.ensure_running(port=4319, allow_provision=False)


class TestWaitForHealth:
    """The first run spends minutes inside npm before anything listens; a fixed
    deadline reported that as a broken provider."""

    class Clock:
        def __init__(self):
            self.now = 1000.0

        def monotonic(self):
            return self.now

        def sleep(self, seconds):
            self.now += seconds

    def _patch_clock(self, monkeypatch):
        clock = self.Clock()
        monkeypatch.setattr(omni.time, "monotonic", clock.monotonic)
        monkeypatch.setattr(omni.time, "sleep", clock.sleep)
        return clock

    def test_gives_up_when_the_child_exits(self, monkeypatch):
        clock = self._patch_clock(monkeypatch)
        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)

        proc = MagicMock()
        proc.poll.return_value = 3

        started = clock.now
        assert omni._wait_for_health("http://127.0.0.1:4319/v1", timeout=120, proc=proc) is None
        # Dead child → no point sitting out the timeout.
        assert clock.now - started < 5

    def test_extends_the_deadline_while_the_log_grows(self, monkeypatch, tmp_path):
        self._patch_clock(monkeypatch)
        log = tmp_path / "omniroute.log"
        log.write_text("")

        polls = {"n": 0}

        def health(*_a, **_kw):
            polls["n"] += 1
            with log.open("a") as fh:
                fh.write("npm installing…\n")
            return polls["n"] > 40  # finishes well past the 5 s deadline

        monkeypatch.setattr(omni, "_health_ok", health)

        proc = MagicMock()
        proc.poll.return_value = None

        assert omni._wait_for_health(
            "http://127.0.0.1:4319/v1", timeout=5, proc=proc, log_path=log
        ) == "http://127.0.0.1:4319/v1"
        assert polls["n"] > 40

    def test_times_out_when_the_gateway_goes_quiet(self, monkeypatch, tmp_path):
        clock = self._patch_clock(monkeypatch)
        log = tmp_path / "omniroute.log"
        log.write_text("started")

        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)

        proc = MagicMock()
        proc.poll.return_value = None

        started = clock.now
        assert omni._wait_for_health(
            "http://127.0.0.1:4319/v1", timeout=5, proc=proc, log_path=log
        ) is None
        assert 5 <= clock.now - started <= 10


class TestBaseUrlFor:
    def test_url_format(self):
        assert omni.base_url_for(4319) == "http://127.0.0.1:4319/v1"


class TestBundled:
    def _stub_bundled(self, monkeypatch, tmp_path):
        node = tmp_path / "bin" / ("node.exe" if omni.IS_WINDOWS else "node")
        node.parent.mkdir(parents=True)
        node.touch()
        entry = tmp_path / "node_modules" / "omniroute" / "bin" / "omniroute.mjs"
        entry.parent.mkdir(parents=True)
        entry.touch()
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)

    def test_available_returns_bundled_when_bundle_present(self, monkeypatch, tmp_path):
        self._stub_bundled(monkeypatch, tmp_path)
        monkeypatch.setattr(omni.shutil, "which", lambda _n: None)
        assert omni.available() == "bundled"

    def test_available_prefers_bundled_over_npx(self, monkeypatch, tmp_path):
        self._stub_bundled(monkeypatch, tmp_path)
        monkeypatch.setattr(omni.shutil, "which", lambda _n: "/usr/bin/npx")
        assert omni.available() == "bundled"

    def test_npx_wins_when_no_bundle(self, monkeypatch, tmp_path):
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)  # empty dir → no node/entry
        monkeypatch.setattr(omni.shutil, "which", lambda n: "/usr/bin/npx" if n == "npx" else None)
        assert omni.available() == "npx"


class TestProvision:
    def _empty_root(self, monkeypatch, tmp_path):
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)
        node = tmp_path / "bin" / ("node.exe" if omni.IS_WINDOWS else "node")
        entry = tmp_path / "node_modules" / "omniroute" / "bin" / "omniroute.mjs"
        return node, entry

    def test_provision_downloads_extracts_and_installs(self, monkeypatch, tmp_path):
        node, entry = self._empty_root(monkeypatch, tmp_path)

        calls = {"download": 0, "extract": 0, "npm": 0}

        def dl(_dest, on_progress=None):
            calls["download"] += 1

        def ex():
            calls["extract"] += 1
            node.parent.mkdir(parents=True)
            node.touch()

        def npm_i(on_progress=None):
            calls["npm"] += 1
            entry.parent.mkdir(parents=True)
            entry.touch()

        monkeypatch.setattr(omni, "_download_node", dl)
        monkeypatch.setattr(omni, "_extract_node", ex)
        monkeypatch.setattr(omni, "_npm_install_omniroute", npm_i)
        assert omni.provision_bundled() == node
        assert calls == {"download": 1, "extract": 1, "npm": 1}

    def test_provision_reports_progress(self, monkeypatch, tmp_path):
        node, entry = self._empty_root(monkeypatch, tmp_path)

        def ex():
            node.parent.mkdir(parents=True)
            node.touch()

        def npm_i(on_progress=None):
            entry.parent.mkdir(parents=True)
            entry.touch()

        monkeypatch.setattr(omni, "_extract_node", ex)
        monkeypatch.setattr(omni, "_npm_install_omniroute", npm_i)

        def fake_download(_dest, on_progress=None):
            if on_progress:
                on_progress(10)
                on_progress(50)
                on_progress(100)

        monkeypatch.setattr(omni, "_download_node", fake_download)
        seen = []
        omni.provision_bundled(on_progress=lambda pct: seen.append(pct))
        assert seen == [10, 50, 100]

    def test_provision_idempotent_when_already_present(self, monkeypatch, tmp_path):
        node, entry = self._empty_root(monkeypatch, tmp_path)
        node.parent.mkdir(parents=True)
        node.touch()
        entry.parent.mkdir(parents=True)
        entry.touch()

        calls = {"download": 0}
        monkeypatch.setattr(omni, "_download_node", lambda dest, on_progress=None: calls.__setitem__("download", calls["download"] + 1))
        assert omni.provision_bundled() == node
        assert calls["download"] == 0  # skipped — already there

    def test_provision_raises_on_checksum_mismatch(self, monkeypatch, tmp_path):
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)

        def bad_download(dest, on_progress=None):
            raise RuntimeError("checksum mismatch")

        monkeypatch.setattr(omni, "_download_node", bad_download)
        with pytest.raises(RuntimeError, match="checksum"):
            omni.provision_bundled()

    def test_ensure_running_provisions_when_no_launchers(self, monkeypatch, tmp_path):
        node = tmp_path / "bin" / ("node.exe" if omni.IS_WINDOWS else "node")
        node.parent.mkdir(parents=True)
        entry = tmp_path / "node_modules" / "omniroute" / "bin" / "omniroute.mjs"
        entry.parent.mkdir(parents=True)

        # Sequence: first available() says nothing, provision creates the
        # bundle, second available() returns "bundled".
        states = iter([None, "bundled"])
        monkeypatch.setattr(omni, "available", lambda: next(states))
        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)

        def fake_provision(on_progress=None, on_status=None):
            node.touch()
            entry.touch()
            return node

        monkeypatch.setattr(omni, "provision_bundled", fake_provision)
        proc = MagicMock()
        proc.returncode = None
        popen_mock = MagicMock(return_value=proc)
        monkeypatch.setattr(omni.subprocess, "Popen", popen_mock)
        monkeypatch.setattr(omni, "_wait_for_health", lambda *_a, **_kw: True)

        result = omni.ensure_running(allow_provision=True)
        assert result is proc
        argv = popen_mock.call_args[0][0]
        assert str(argv[0]).endswith(("node", "node.exe"))
        assert "omniroute.mjs" in str(argv[1])

    def test_ensure_running_refuses_provision_when_opted_out(self, monkeypatch):
        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)
        monkeypatch.setattr(omni, "available", lambda: None)
        with pytest.raises(RuntimeError, match="n[eo]ither npx nor docker"):
            omni.ensure_running(allow_provision=False)


class TestNodeDist:
    def test_url_for_current_platform(self, monkeypatch):
        monkeypatch.setattr(omni.sys, "platform", "linux")
        monkeypatch.setattr(omni.platform, "machine", lambda: "x86_64")
        url, fname = omni._node_dist_url()
        assert fname == f"node-v{omni._NODE_VERSION}-linux-x64.tar.xz"
        assert omni._NODE_VERSION in url

    def test_url_for_windows(self, monkeypatch):
        monkeypatch.setattr(omni.sys, "platform", "win32")
        monkeypatch.setattr(omni.platform, "machine", lambda: "AMD64")
        url, fname = omni._node_dist_url()
        assert fname.endswith(".zip") and "win-x64" in fname

    def test_url_for_macos_arm(self, monkeypatch):
        monkeypatch.setattr(omni.sys, "platform", "darwin")
        monkeypatch.setattr(omni.platform, "machine", lambda: "arm64")
        url, fname = omni._node_dist_url()
        assert "darwin-arm64" in fname

    def test_unsupported_platform_raises(self, monkeypatch):
        monkeypatch.setattr(omni.sys, "platform", "sunos5")
        with pytest.raises(RuntimeError, match="[Uu]nsupported"):
            omni._node_dist_url()


class TestLauncherArgv:
    """Windows resolves `npx` to a .cmd shim, which CreateProcessW refuses to
    run — the free-provider click died with a bare 500 because of it."""

    def test_windows_npx_shim_goes_through_cmd(self, monkeypatch):
        monkeypatch.setattr(omni, "IS_WINDOWS", True)
        monkeypatch.setattr(
            omni.shutil, "which", lambda n: r"C:\Program Files\nodejs\npx.cmd" if n == "npx" else None
        )

        argv = omni._launcher_argv("npx", 4319)

        assert argv[0].lower().endswith("cmd.exe")
        assert argv[1].lower() == "/c"
        assert argv[2].lower().endswith("npx.cmd")
        assert "omniroute@" in argv[4]
        assert "serve" in argv
        assert argv[argv.index("--port") + 1] == "4319"

    def test_posix_npx_uses_resolved_path(self, monkeypatch):
        monkeypatch.setattr(omni, "IS_WINDOWS", False)
        monkeypatch.setattr(omni.shutil, "which", lambda n: "/usr/bin/npx" if n == "npx" else None)

        argv = omni._launcher_argv("npx", 4319)

        assert argv[0] == "/usr/bin/npx"
        assert "--yes" in argv

    def test_docker_argv_publishes_the_port(self):
        argv = omni._launcher_argv("docker", 4319)

        assert argv[0] == "docker"
        assert "4319:4319" in argv
        assert omni._OMNIROUTE_DOCKER_IMAGE in argv

    def test_bundled_argv_runs_node_directly(self, monkeypatch, tmp_path):
        bin_dir = tmp_path / ("." if omni.IS_WINDOWS else "bin")
        bin_dir.mkdir(parents=True, exist_ok=True)
        node = bin_dir / ("node.exe" if omni.IS_WINDOWS else "node")
        node.touch()
        entry = tmp_path / "node_modules" / "omniroute" / "bin" / "omniroute.mjs"
        entry.parent.mkdir(parents=True)
        entry.touch()
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)

        argv = omni._launcher_argv("bundled", 4319)

        assert argv[0] == str(node)
        assert argv[1] == str(entry)
        assert "serve" in argv
        assert argv[argv.index("--port") + 1] == "4319"

    def test_bundled_argv_requires_a_complete_bundle(self, monkeypatch, tmp_path):
        monkeypatch.setattr(omni, "bundled_root", lambda: tmp_path)

        with pytest.raises(RuntimeError, match="incomplete"):
            omni._launcher_argv("bundled", 4319)


class TestHealthProbe:
    """OmniRoute answers 401 on /v1/models; urllib raises HTTPError for 4xx, so
    an HTTP probe reported a live gateway as dead."""

    def test_healthy_when_the_port_accepts(self, monkeypatch):
        seen = {}

        class Conn:
            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        def connect(address, timeout=None):
            seen["address"] = address
            return Conn()

        monkeypatch.setattr(omni.socket, "create_connection", connect)

        assert omni._health_ok("http://127.0.0.1:4319/v1") is True
        assert seen["address"] == ("127.0.0.1", 4319)

    def test_unhealthy_when_the_port_refuses(self, monkeypatch):
        def connect(*_a, **_kw):
            raise ConnectionRefusedError("refused")

        monkeypatch.setattr(omni.socket, "create_connection", connect)

        assert omni._health_ok("http://localhost:4319/v1") is False
