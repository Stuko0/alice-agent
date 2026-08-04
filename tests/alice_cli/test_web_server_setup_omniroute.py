"""Tests for the OmniRoute setup-side REST surface."""

import pytest
from starlette.testclient import TestClient

from alice_cli import web_server
from alice_cli.web_server import app


@pytest.fixture
def client(monkeypatch, tmp_path):
    import alice_state
    from alice_constants import get_alice_home

    monkeypatch.setattr(alice_state, "DEFAULT_DB_PATH", get_alice_home() / "state.db")
    c = TestClient(app)
    c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return c


class TestSetupOmnirouteStart:
    def test_post_returns_ready_when_already_healthy(self, client, monkeypatch):
        from alice_cli import omniroute as omni

        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: True)
        monkeypatch.setattr(omni, "base_url_for", lambda port=4319: "http://127.0.0.1:4319/v1")

        r = client.post("/api/setup/omniroute/start", json={})
        assert r.status_code == 200, r.text
        assert r.json()["base_url"] == "http://127.0.0.1:4319/v1"

    def test_post_provisions_when_no_launchers(self, client, monkeypatch):
        from alice_cli import omniroute as omni

        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)

        seen = {"progress": []}

        def fake_ensure(port=4319, on_progress=None, allow_provision=True):
            assert allow_provision
            if on_progress:
                on_progress(50)
            return None

        monkeypatch.setattr(omni, "ensure_running", fake_ensure)
        monkeypatch.setattr(omni, "base_url_for", lambda port=4319: "http://127.0.0.1:4319/v1")

        r = client.post("/api/setup/omniroute/start", json={})
        assert r.status_code == 200, r.text

    def test_post_500_when_provisioning_fails(self, client, monkeypatch):
        from alice_cli import omniroute as omni

        monkeypatch.setattr(omni, "_health_ok", lambda *_a, **_kw: False)

        def bad_ensure(*_a, **_kw):
            raise RuntimeError("checksum mismatch")

        monkeypatch.setattr(omni, "ensure_running", bad_ensure)

        r = client.post("/api/setup/omniroute/start", json={})
        assert r.status_code == 500
        assert "checksum" in r.json()["detail"]
