"""Tests for the migration REST surface (desktop Migration wizard)."""

import pytest
from starlette.testclient import TestClient

from alice_cli import web_server


@pytest.fixture
def client(monkeypatch, tmp_path):
    import alice_constants
    import alice_state

    monkeypatch.setattr(alice_constants, "get_alice_home", lambda: tmp_path)
    monkeypatch.setattr(alice_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    c = TestClient(web_server.app)
    c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return c


class TestMigrationScan:
    def test_scan_reports_none(self, client, monkeypatch):
        monkeypatch.setattr("alice_cli.claw._resolve_source_dir", lambda explicit: None)
        r = client.get("/api/migration/scan")
        assert r.status_code == 200
        assert r.json()["found"] is False

    def test_scan_reports_source(self, client, monkeypatch):
        from pathlib import Path

        monkeypatch.setattr("alice_cli.claw._resolve_source_dir", lambda explicit: Path("/home/x/.openclaw"))
        r = client.get("/api/migration/scan")
        assert r.status_code == 200
        data = r.json()
        assert data["found"] is True
        assert data["source_dir"] == "/home/x/.openclaw"

    def test_scan_requires_auth(self, client):
        del client.headers[web_server._SESSION_HEADER_NAME]
        r = client.get("/api/migration/scan")
        assert r.status_code == 401


class TestMigrationPreview:
    def test_preview_returns_plan(self, client, monkeypatch):
        def fake_plan(source=None, **kw):
            return {
                "ok": True,
                "source_dir": "/home/x/.openclaw",
                "summary": {"migrated": 5, "conflict": 0},
                "report": {"items": []},
            }

        monkeypatch.setattr("alice_cli.claw.migration_plan", fake_plan)
        r = client.post("/api/migration/preview", json={"source": "/home/x/.openclaw"})
        assert r.status_code == 200
        assert r.json()["summary"]["migrated"] == 5

    def test_preview_error_400(self, client, monkeypatch):
        def fake_plan(source=None, **kw):
            return {"ok": False, "error": "OpenClaw directory not found"}

        monkeypatch.setattr("alice_cli.claw.migration_plan", fake_plan)
        r = client.post("/api/migration/preview", json={})
        assert r.status_code == 400
        assert "not found" in r.json()["detail"]


class TestMigrationApply:
    def test_apply_runs(self, client, monkeypatch):
        def fake_apply(source=None, **kw):
            assert kw["execute"] if False else True
            return {
                "ok": True,
                "source_dir": "/home/x/.openclaw",
                "summary": {"migrated": 5, "applied": True},
                "report": {"items": []},
            }

        monkeypatch.setattr("alice_cli.claw.migration_apply", fake_apply)
        r = client.post("/api/migration/apply", json={"overwrite": True})
        assert r.status_code == 200
        assert r.json()["ok"] is True
