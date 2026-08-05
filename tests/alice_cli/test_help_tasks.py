"""Tests for the task-scoped help index + REST surface."""

import pytest
from starlette.testclient import TestClient

from alice_cli import help_tasks, web_server


class TestIndex:
    def test_list_has_expected_tasks(self):
        ids = {t.id for t in help_tasks.list_tasks()}
        assert {"add-provider", "first-run", "update"} <= ids

    def test_get_by_id(self):
        task = help_tasks.get_task("backup")
        assert task is not None
        assert task.id == "backup"
        assert task.doc_path.name.endswith(".md")

    def test_get_case_insensitive(self):
        assert help_tasks.get_task("BACKUP") is not None

    def test_unknown_returns_none(self):
        assert help_tasks.get_task("nope") is None

    def test_markdown_reads_real_doc(self):
        task = help_tasks.get_task("first-run")
        md = help_tasks.task_markdown(task)
        assert md is not None and len(md) > 50


@pytest.fixture
def client(monkeypatch, tmp_path):
    import alice_constants
    import alice_state

    monkeypatch.setattr(alice_constants, "get_alice_home", lambda: tmp_path)
    monkeypatch.setattr(alice_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    c = TestClient(web_server.app)
    c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return c


class TestHelpApi:
    def test_topics(self, client):
        r = client.get("/api/help/topics")
        assert r.status_code == 200
        ids = [t["id"] for t in r.json()]
        assert "add-provider" in ids

    def test_task_content(self, client):
        r = client.get("/api/help/task/backup")
        assert r.status_code == 200
        data = r.json()
        assert data["id"] == "backup"
        assert len(data["markdown"]) > 50

    def test_unknown_task_404(self, client):
        r = client.get("/api/help/task/nope")
        assert r.status_code == 404
