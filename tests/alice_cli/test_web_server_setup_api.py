"""Tests for the /api/setup/* REST surface added for the desktop Setup Driver.

The desktop app drives first-run setup through these endpoints instead of
shelling out to the interactive ``alice setup`` CLI. Each endpoint wraps an
existing primitive from ``alice_cli.setup`` / ``alice_cli.config`` so the
HTTP layer is thin — the wizard logic stays in one place.

Auth mirrors every other sensitive endpoint: the per-process session token
in the ``X-Alice-Session-Token`` header.
"""

import pytest


@pytest.fixture
def client(monkeypatch, tmp_path):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import alice_state
    from alice_constants import get_alice_home
    from alice_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(alice_state, "DEFAULT_DB_PATH", get_alice_home() / "state.db")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


class TestSetupStatus:
    def test_status_returns_readiness(self, client):
        resp = client.get("/api/setup/status")
        assert resp.status_code == 200
        data = resp.json()
        assert "configured" in data
        assert "provider" in data
        assert "terminal_backend" in data


class TestSetupTerminalBackend:
    def test_post_local_backend(self, client):
        resp = client.post("/api/setup/terminal-backend", json={"backend": "local"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["terminal"]["backend"] == "local"

    def test_rejects_unknown_backend(self, client):
        resp = client.post("/api/setup/terminal-backend", json={"backend": "explode"})
        assert resp.status_code == 400

    def test_persists_to_config(self, client):
        client.post("/api/setup/terminal-backend", json={"backend": "docker"})
        from alice_cli.config import load_config
        cfg = load_config()
        assert cfg["terminal"]["backend"] == "docker"
