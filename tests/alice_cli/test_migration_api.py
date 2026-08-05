"""Tests for the programmatic migration API (desktop Migration wizard feed).

The GUI wizard runs `alice claw migrate` logic without a terminal: scan →
preview (dry-run) → apply. These tests exercise the JSON-safe wrappers with
a stubbed migration module (the real one lives in the openclaw-migration
skill and is not installed in CI)."""

from pathlib import Path

import pytest

from alice_cli import claw


@pytest.fixture
def fake_migration_module(monkeypatch):
    """Fake `openclaw_to_alice` module with a Migrator class returning a
    structured report — mirrors the real skill's contract."""

    class FakeMigrator:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.execute = kwargs.get("execute", False)

        def migrate(self):
            summary = {"migrated": 3 if self.execute else 3, "conflict": 0}
            if self.execute:
                summary["applied"] = True
            return {
                "summary": summary,
                "items": [
                    {"kind": "memory", "name": "note1", "status": "ok"},
                    {"kind": "skill", "name": "skill-a", "status": "ok"},
                    {"kind": "config", "name": "config.yaml", "status": "ok"},
                ],
            }

    mod = type("FakeMod", (), {"Migrator": FakeMigrator, "resolve_selected_options": lambda *a, **k: {}})
    monkeypatch.setattr(claw, "_load_migration_module", lambda path: mod)
    return mod


class TestMigrationPlan:
    def test_plan_returns_report(self, tmp_path, fake_migration_module, monkeypatch):
        source = tmp_path / ".openclaw"
        source.mkdir()
        (source / "config.yaml").touch()
        monkeypatch.setattr(claw, "_find_migration_script", lambda: Path("/fake/openclaw_to_alice.py"))

        result = claw.migration_plan(str(source))
        assert result["ok"] is True
        assert result["summary"]["migrated"] == 3
        assert "items" in result["report"]

    def test_plan_missing_source(self, tmp_path, fake_migration_module, monkeypatch):
        monkeypatch.setattr(claw, "_find_migration_script", lambda: Path("/fake/openclaw_to_alice.py"))
        result = claw.migration_plan(str(tmp_path / "does-not-exist"))
        assert result["ok"] is False
        assert "error" in result

    def test_plan_missing_script(self, tmp_path, monkeypatch):
        source = tmp_path / ".openclaw"
        source.mkdir()
        monkeypatch.setattr(claw, "_find_migration_script", lambda: None)
        result = claw.migration_plan(str(source))
        assert result["ok"] is False
        assert "script" in result["error"].lower()

    def test_plan_sets_execute_false(self, tmp_path, fake_migration_module, monkeypatch):
        source = tmp_path / ".openclaw"
        source.mkdir()
        monkeypatch.setattr(claw, "_find_migration_script", lambda: Path("/fake/openclaw_to_alice.py"))
        seen = {}

        original = fake_migration_module.Migrator

        class SpyMigrator(original):
            def __init__(self, **kw):
                seen["kwargs"] = kw
                super().__init__(**kw)

        fake_migration_module.Migrator = SpyMigrator
        claw.migration_plan(str(source))
        assert seen["kwargs"]["execute"] is False


class TestMigrationApply:
    def test_apply_sets_execute_true(self, tmp_path, fake_migration_module, monkeypatch):
        source = tmp_path / ".openclaw"
        source.mkdir()
        monkeypatch.setattr(claw, "_find_migration_script", lambda: Path("/fake/openclaw_to_alice.py"))
        seen = {}

        original = fake_migration_module.Migrator

        class SpyMigrator(original):
            def __init__(self, **kw):
                seen["kwargs"] = kw
                super().__init__(**kw)

        fake_migration_module.Migrator = SpyMigrator
        result = claw.migration_apply(str(source))
        assert seen["kwargs"]["execute"] is True
        assert result["ok"] is True
        assert result["summary"]["applied"] is True

    def test_apply_forwards_options(self, tmp_path, fake_migration_module, monkeypatch):
        source = tmp_path / ".openclaw"
        source.mkdir()
        monkeypatch.setattr(claw, "_find_migration_script", lambda: Path("/fake/openclaw_to_alice.py"))
        seen = {}

        original = fake_migration_module.Migrator

        class SpyMigrator(original):
            def __init__(self, **kw):
                seen["kwargs"] = kw
                super().__init__(**kw)

        fake_migration_module.Migrator = SpyMigrator
        claw.migration_apply(str(source), overwrite=True, migrate_secrets=True, preset="full")
        assert seen["kwargs"]["overwrite"] is True
        assert seen["kwargs"]["migrate_secrets"] is True
        assert seen["kwargs"]["execute"] is True
