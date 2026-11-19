"""Tests for the OmniRoute setup-side REST surface.

The endpoint used to provision synchronously inside the request: a Node
download plus an npm install, which outlived the desktop shell's proxy timeout
and surfaced as a bare 500 (the handler only translated RuntimeError; anything
else became Starlette's "Internal Server Error"). It now starts a background
job and the renderer polls the state.
"""

import urllib.error

import pytest
from starlette.testclient import TestClient

from alice_cli import web_server
from alice_cli.web_server import app


class _InlineThread:
    """Stand-in for threading.Thread that runs the body on start()."""

    def __init__(self, target=None, **_kwargs):
        self._target = target

    def start(self):
        if self._target is not None:
            self._target()


@pytest.fixture
def client(monkeypatch):
    import alice_state
    from alice_constants import get_alice_home

    monkeypatch.setattr(alice_state, "DEFAULT_DB_PATH", get_alice_home() / "state.db")
    c = TestClient(app)
    c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return c


@pytest.fixture(autouse=True)
def reset_job():
    """The job state is module-level; each test needs a clean slate."""

    def reset():
        web_server._omniroute_update(
            state="idle", progress=0, message="", error=None, base_url="", started_at=None
        )

    reset()
    yield
    reset()


def _settle(*, state="ready", error=None, base_url="http://127.0.0.1:4319/v1"):
    web_server._omniroute_update(state=state, progress=100 if state == "ready" else 0, error=error, base_url=base_url)


class TestSetupOmnirouteStart:
    def test_post_returns_immediately_and_reports_ready_after_worker(self, client, monkeypatch):
        calls = {"worker": 0}

        def fake_worker():
            calls["worker"] += 1
            _settle()

        monkeypatch.setattr(web_server, "_omniroute_worker", fake_worker)
        monkeypatch.setattr(web_server.threading, "Thread", _InlineThread)

        r = client.post("/api/setup/omniroute/start", json={})

        assert r.status_code == 200, r.text
        body = r.json()
        assert calls["worker"] == 1
        assert body["state"] == "ready"
        assert body["configured"] is True
        assert body["base_url"] == "http://127.0.0.1:4319/v1"

    def test_post_does_not_start_a_second_job_while_starting(self, client, monkeypatch):
        web_server._omniroute_update(state="starting", progress=10, message="Installing the local runtime…")

        def explode(**_kwargs):
            raise AssertionError("a second provisioning thread must not start")

        monkeypatch.setattr(web_server.threading, "Thread", explode)

        r = client.post("/api/setup/omniroute/start", json={})

        assert r.status_code == 200, r.text
        assert r.json()["state"] == "starting"
        # The in-flight job's message is preserved, not reset to "Starting…".
        assert "Installing" in r.json()["message"]


class TestSetupOmnirouteStatus:
    def test_status_reports_progress(self, client):
        web_server._omniroute_update(state="starting", progress=42, message="Installing OmniRoute…")

        r = client.get("/api/setup/omniroute/status")

        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {
            "state": "starting",
            "progress": 42,
            "message": "Installing OmniRoute…",
            "error": None,
            "base_url": "",
            "started_at": None,
            "configured": False,
        }

    def test_status_surfaces_the_error_text(self, client):
        _settle(state="error", error="npm install failed with exit 1; see ~/.alice/omniroute")

        body = client.get("/api/setup/omniroute/status").json()

        assert body["state"] == "error"
        assert body["configured"] is False
        assert "npm install failed" in body["error"]


class TestOmnirouteWorker:
    def test_worker_records_provisioning_failure(self, monkeypatch):
        from alice_cli import omniroute as omni

        monkeypatch.setattr(omni, "base_url_for", lambda port=4319: "http://127.0.0.1:4319/v1")

        def bad_ensure(**_kwargs):
            raise urllib.error.URLError("nodename nor servname provided")

        monkeypatch.setattr(omni, "ensure_running", bad_ensure)

        web_server._omniroute_worker()

        state = web_server._omniroute_snapshot()
        assert state["state"] == "error"
        assert "nodejs.org" in state["error"]
        assert "URLError" in state["error"]

    def test_worker_records_non_runtime_error(self, monkeypatch):
        """The old handler only caught RuntimeError; everything else was a bare 500."""
        from alice_cli import omniroute as omni

        monkeypatch.setattr(omni, "base_url_for", lambda port=4319: "http://127.0.0.1:4319/v1")

        def bad_ensure(**_kwargs):
            raise FileNotFoundError("npx")

        monkeypatch.setattr(omni, "ensure_running", bad_ensure)

        web_server._omniroute_worker()

        state = web_server._omniroute_snapshot()
        assert state["state"] == "error"
        assert "FileNotFoundError" in state["error"]

    def test_worker_configures_the_model_on_success(self, monkeypatch):
        from alice_cli import omniroute as omni

        monkeypatch.setattr(omni, "base_url_for", lambda port=4319: "http://127.0.0.1:4319/v1")
        monkeypatch.setattr(omni, "ensure_running", lambda **_kw: None)
        monkeypatch.setattr(omni, "mint_local_token", lambda: "omniroute-local-test")

        saved = {}

        monkeypatch.setattr(web_server, "load_config", lambda: {"model": {}})
        monkeypatch.setattr(web_server, "save_config", lambda cfg: saved.update(cfg))

        web_server._omniroute_worker()

        state = web_server._omniroute_snapshot()
        assert state["state"] == "ready"
        assert state["base_url"] == "http://127.0.0.1:4319/v1"
        assert saved["model"]["provider"] == "custom"
        assert saved["model"]["base_url"] == "http://127.0.0.1:4319/v1"
        assert saved["model"]["api_key"] == "omniroute-local-test"


class TestFreeEndpointSetup:
    """The URL-only free provider: no install, no key, one request."""

    def test_get_lists_endpoints_without_keys(self, client):
        r = client.get("/api/setup/free-endpoints")

        assert r.status_code == 200, r.text
        body = r.json()
        assert body and body[0]["id"] == "pollinations"
        assert "api_key" not in body[0]

    def test_post_probes_then_configures(self, client, monkeypatch):
        from alice_cli import free_endpoints

        probed = []
        monkeypatch.setattr(free_endpoints, "probe", lambda endpoint, **_kw: probed.append(endpoint["id"]))
        monkeypatch.setattr(
            free_endpoints,
            "apply_config",
            lambda endpoint: {
                "base_url": endpoint["base_url"],
                "model": endpoint["model"],
                "provider": "custom",
            },
        )

        r = client.post("/api/setup/free-endpoint", json={})

        assert r.status_code == 200, r.text
        body = r.json()
        assert probed == ["pollinations"]
        assert body["configured"] is True
        assert body["id"] == "pollinations"
        assert body["base_url"].startswith("https://")
        assert body["model"]

    def test_post_surfaces_a_probe_failure_as_502(self, client, monkeypatch):
        from alice_cli import free_endpoints

        def explode(*_a, **_kw):
            raise RuntimeError("The free endpoint is rate-limiting anonymous requests right now.")

        monkeypatch.setattr(free_endpoints, "probe", explode)

        r = client.post("/api/setup/free-endpoint", json={})

        assert r.status_code == 502, r.text
        assert "rate-limiting" in r.json()["detail"]

    def test_post_rejects_an_unknown_endpoint(self, client):
        r = client.post("/api/setup/free-endpoint", json={"id": "does-not-exist"})

        assert r.status_code == 400
        assert "unknown free endpoint" in r.json()["detail"]

    def test_post_bounds_a_hanging_probe(self, client, monkeypatch):
        """urllib's timeout is per socket read; a trickling response would hold
        the request open past the desktop proxy's limit."""
        import time

        from alice_cli import free_endpoints

        monkeypatch.setattr(web_server, "_FREE_ENDPOINT_PROBE_TIMEOUT_S", 0.05)
        monkeypatch.setattr(free_endpoints, "probe", lambda *_a, **_kw: time.sleep(1.0))

        r = client.post("/api/setup/free-endpoint", json={})

        assert r.status_code == 504, r.text
        assert "did not answer" in r.json()["detail"]

    def test_post_force_skips_the_probe(self, client, monkeypatch):
        """A blocked probe must not be a dead end."""
        from alice_cli import free_endpoints

        def explode(*_a, **_kw):
            raise AssertionError("force must not probe")

        monkeypatch.setattr(free_endpoints, "probe", explode)
        monkeypatch.setattr(
            free_endpoints,
            "apply_config",
            lambda endpoint: {"base_url": endpoint["base_url"], "model": endpoint["model"], "provider": "custom"},
        )

        r = client.post("/api/setup/free-endpoint", json={"force": True})

        assert r.status_code == 200, r.text
        assert r.json()["configured"] is True
        assert r.json()["unverified"] is True
