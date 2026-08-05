"""Tests for the DPR REST surface — /api/providers/custom*.

The desktop Settings → Providers tab uses these to list, add, test and
remove custom providers without touching YAML by hand."""

import pytest
from starlette.testclient import TestClient

from alice_cli import web_server


@pytest.fixture
def client(monkeypatch, tmp_path):
    import alice_constants
    import alice_state

    monkeypatch.setattr(alice_constants, "get_alice_home", lambda: tmp_path)
    (tmp_path / "providers.d").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(alice_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    c = TestClient(web_server.app)
    c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return c


class TestListCustom:
    def test_empty_by_default(self, client):
        r = client.get("/api/providers/custom")
        assert r.status_code == 200
        assert r.json() == []

    def test_returns_registered(self, client):
        client.post("/api/providers/custom", json={"name": "Together AI", "base_url": "https://api.together.xyz/v1"})
        r = client.get("/api/providers/custom")
        assert r.status_code == 200
        assert any(p["name"] == "Together AI" for p in r.json())


class TestAddCustom:
    def test_add_valid(self, client):
        r = client.post(
            "/api/providers/custom",
            json={"name": "Groq", "base_url": "https://api.groq.com/openai/v1", "api_key_env": "GROQ_API_KEY"},
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["id"] == "groq"
        assert data["base_url"] == "https://api.groq.com/openai/v1"

    def test_add_invalid_returns_400(self, client):
        r = client.post("/api/providers/custom", json={"name": "x", "base_url": "not-a-url"})
        assert r.status_code == 400
        assert "URL" in r.json()["detail"]

    def test_add_missing_fields_returns_400(self, client):
        r = client.post("/api/providers/custom", json={})
        assert r.status_code == 400


class TestDeleteCustom:
    def test_delete_ok(self, client):
        client.post("/api/providers/custom", json={"name": "Groq", "base_url": "https://api.groq.com/openai/v1"})
        r = client.delete("/api/providers/custom/groq")
        assert r.status_code == 200
        assert r.json()["removed"] is True

    def test_delete_missing_404(self, client):
        r = client.delete("/api/providers/custom/nope")
        assert r.status_code == 404


class TestProbeCustom:
    def test_probe_ok(self, client, monkeypatch):
        import urllib.request

        class FakeResp:
            status = 200

            def read(self):
                return b'{"data":[{"id":"m1"}]}'

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(url, timeout=None):
            return FakeResp()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        client.post("/api/providers/custom", json={"name": "Groq", "base_url": "https://api.groq.com/openai/v1"})
        r = client.post("/api/providers/custom/groq/test")
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_probe_unknown_404(self, client):
        r = client.post("/api/providers/custom/nope/test")
        assert r.status_code == 404
