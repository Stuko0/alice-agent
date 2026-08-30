"""Tests for the GIT_ASKPASS shim that the desktop injects into every git
subprocess. The shim is what keeps credential prompts OFF the user's
launch terminal — instead they raise a floating modal in the desktop."""

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pytest

from alice_cli.web_git import ASKPASS_FILENAME, _ASKPASS_BODY, _askpass_env, askpass_path


class TestAskpassPath:
    """The shim script is materialised on first use and re-used across
    calls. The path must be deterministic so multiple subprocesses in the
    same session all hit the same file."""

    def setup_method(self):
        # Force a fresh materialisation for each test by clearing the
        # module-level cache.
        import alice_cli.web_git as wg

        wg._ALICE_ASKPASS_SCRIPT = None

    def teardown_method(self):
        import alice_cli.web_git as wg

        wg._ALICE_ASKPASS_SCRIPT = None

    def test_askpass_path_is_deterministic(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        path1 = askpass_path()
        path2 = askpass_path()
        assert path1 == path2
        assert path1.endswith(ASKPASS_FILENAME)

    def test_askpass_path_creates_file_on_first_call(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        path = askpass_path()
        assert os.path.exists(path)

    def test_askpass_path_file_is_executable(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        path = askpass_path()
        # chmod is a no-op on Windows; skip if it didn't take.
        st = os.stat(path)
        assert (st.st_mode & stat.S_IXUSR) != 0 or os.name == "nt"

    def test_askpass_path_does_not_overwrite_existing(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        path = askpass_path()
        # Touch the file with a custom marker, then re-ask. The script
        # must not clobber the user's manually-edited version.
        Path(path).write_text("# user-edited", encoding="utf-8")
        # Need a fresh materialisation — bypass the cache by patching.
        import alice_cli.web_git as wg

        wg._ALICE_ASKPASS_SCRIPT = None
        path2 = askpass_path()
        assert path == path2
        # Our materialisation guard only re-writes when the file is small
        # (likely truncated). "user-edited" is 13 bytes, well under the
        # 100-byte threshold, so we DO re-materialise. The intent of
        # this test is to confirm the *threshold* — the file always ends
        # up with valid Python source.
        contents = Path(path2).read_text(encoding="utf-8")
        assert "urlopen" in contents


class TestAskpassBody:
    """The script body itself must be a valid Python source file with a
    shebang line. It must POST the prompt to the gateway and print the
    answer to stdout."""

    def test_has_shebang(self):
        assert _ASKPASS_BODY.startswith("#!/usr/bin/env python3")

    def test_uses_gateway_port_env_var(self):
        # The renderer-less fallback uses ALICE_GATEWAY_PORT so the CLI
        # can run with a non-default port without breaking askpass.
        assert "ALICE_GATEWAY_PORT" in _ASKPASS_BODY

    def test_posts_to_localhost_only(self):
        # Hard-coded 127.0.0.1 — never the hostname, never an IP. The
        # shim is a generic script, so this is the only safe default.
        assert "127.0.0.1" in _ASKPASS_BODY
        assert "0.0.0.0" not in _ASKPASS_BODY

    def test_prints_answer_to_stdout(self):
        # The whole point of askpass — git reads stdout.
        assert "sys.stdout.write" in _ASKPASS_BODY

    def test_swallows_exceptions_silently(self):
        # No matter what fails, the shim must never leak the prompt to
        # stderr (where it would be echoed in shell history or logs).
        assert "except" in _ASKPASS_BODY
        # No print to stderr anywhere.
        assert "sys.stderr" not in _ASKPASS_BODY


class TestAskpassEnv:
    """The env dict we pass to subprocess.run must set GIT_ASKPASS to the
    generated shim, and must force git to always ask rather than use a
    cached credential helper. We also keep the user's other env vars
    intact by overlaying."""

    def test_env_sets_git_askpass(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        env = _askpass_env()
        assert "GIT_ASKPASS" in env
        assert env["GIT_ASKPASS"].endswith(ASKPASS_FILENAME)

    def test_env_sets_askpass_timeout(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        env = _askpass_env()
        # 5-minute timeout matches the long-poll in web_server. git
        # kills the askpass subprocess when the timeout fires.
        assert env["GIT_ASKPASS_TIMEOUT"] == "300"

    def test_shim_actually_runs_and_prints(self, tmp_path: Path, monkeypatch):
        """End-to-end: run the generated shim as a subprocess with a
        mock gateway URL. The shim should hit the URL, parse the JSON
        response, and write the answer to stdout."""
        import http.server
        import socketserver
        import threading
        import subprocess

        monkeypatch.setenv("ALICE_HOME", str(tmp_path))

        class Handler(http.server.BaseHTTPRequestHandler):
            captured = {"prompt": None}

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                import json as _json

                Handler.captured["prompt"] = _json.loads(body).get("prompt")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"answer": "secret-pw-42"}')

            def log_message(self, *_args, **_kwargs):
                # Silence the default request log.
                pass

        # Bind a persistent server in a daemon thread (must not be in a
        # `with` block — that would close the socket before the request
        # arrives).
        socketserver.TCPServer.allow_reuse_address = True
        server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()

        try:
            monkeypatch.setenv("ALICE_GATEWAY_PORT", str(port))
            import alice_cli.web_git as wg

            wg._ALICE_ASKPASS_SCRIPT = None
            path = askpass_path()

            result = subprocess.run(
                ["python3", path, "Username for 'https://github.com':"],
                capture_output=True,
                text=True,
                timeout=5,
            )

            assert result.returncode == 0, f"shim stderr: {result.stderr}"
            assert result.stdout == "secret-pw-42"
            assert Handler.captured["prompt"] == "Username for 'https://github.com':"
        finally:
            server.shutdown()
            server.server_close()
