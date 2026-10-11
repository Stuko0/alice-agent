"""Effectiveness signal — the outcome dimension of skill telemetry.

Fase 1 of `.hermes/plans/2026-09-22_174556-autoaprendizaje-verificado-core.md`.

These are behavior contracts, not snapshots: they assert how a recorded
outcome must RELATE to activity (never counted as it, never rejuvenating a
skill) and to curation eligibility (only curator-managed skills get one).
"""

import importlib
import json
from pathlib import Path

import pytest


@pytest.fixture
def skills_home(tmp_path, monkeypatch):
    """Isolated ALICE_HOME with a clean skills/ dir and a reloaded module."""
    home = tmp_path / ".alice"
    (home / "skills").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("ALICE_HOME", str(home))
    import tools.skill_usage as mod

    importlib.reload(mod)
    return home


def _write_skill(skills_home: Path, name: str) -> None:
    d = skills_home / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\n# body\n",
        encoding="utf-8",
    )


def _raw_record(skills_home: Path, name: str) -> dict:
    """The persisted record for *name*, or {} when no sidecar exists yet.

    A rejected write must leave NO sidecar behind, so a missing file is a
    valid (and expected) result — not an error.
    """
    path = skills_home / "skills" / ".usage.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get(name, {})


# ---------------------------------------------------------------------------
# The invariant that makes the signal safe: outcome is NOT activity
# ---------------------------------------------------------------------------


def test_outcome_is_not_counted_as_activity(skills_home):
    """A recorded outcome must never inflate activity_count.

    If it did, a skill that keeps FAILING would look busy enough to survive
    the inactivity prune in agent.curator — the exact inversion the signal
    exists to prevent.
    """
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    assert su.record_outcome("demo-skill", "hurt", note="paso 3 falló") is True

    rec = su.get_record("demo-skill")
    assert rec["hurt_count"] == 1
    assert su.activity_count(rec) == 0


def test_outcome_does_not_rejuvenate_last_activity(skills_home):
    """Recording an outcome must not move the activity clock forward."""
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    su.bump_use("demo-skill")
    before = su.get_record("demo-skill")["last_used_at"]

    su.record_outcome("demo-skill", "hurt")

    after_rec = su.get_record("demo-skill")
    assert after_rec["last_used_at"] == before
    assert su.latest_activity_at(after_rec) == before


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def test_record_outcome_counts_and_aggregates(skills_home):
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    su.record_outcome("demo-skill", "helped")
    su.record_outcome("demo-skill", "hurt", note="el paso 3 falló dos veces")

    rec = su.get_record("demo-skill")
    assert rec["helped_count"] == 1
    assert rec["hurt_count"] == 1
    assert rec["last_outcome"] == "hurt"
    assert rec["last_outcome_note"] == "el paso 3 falló dos veces"
    assert rec["last_outcome_at"]

    eff = su.effectiveness(rec)
    assert eff["helped"] == 1 and eff["hurt"] == 1
    assert eff["net"] == 0
    assert eff["evaluated"] == 2
    assert eff["rate"] == 0.5


def test_neutral_is_stored_but_does_not_dilute_rate(skills_home):
    """Neutral = absence of evidence. It must not look like half a failure."""
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    su.record_outcome("demo-skill", "helpED")  # case-insensitive
    su.record_outcome("demo-skill", "neutral")
    su.record_outcome("demo-skill", "neutral")

    eff = su.effectiveness(su.get_record("demo-skill"))
    assert eff["helped"] == 1
    assert eff["hurt"] == 0
    assert eff["evaluated"] == 1
    assert eff["rate"] == 1.0
    assert eff["last"] == "neutral"


def test_effectiveness_rate_is_none_until_a_decisive_outcome(skills_home):
    """Unknown must be distinguishable from zero — callers branch on None."""
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    su.record_outcome("demo-skill", "neutral")

    eff = su.effectiveness(su.get_record("demo-skill"))
    assert eff["evaluated"] == 0
    assert eff["rate"] is None


def test_note_is_truncated(skills_home):
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    su.record_outcome("demo-skill", "hurt", note="x" * 500)

    assert len(su.get_record("demo-skill")["last_outcome_note"]) == su._OUTCOME_NOTE_MAX


def test_outcome_survives_reread_from_disk(skills_home):
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    su.record_outcome("demo-skill", "helped")

    assert _raw_record(skills_home, "demo-skill")["helped_count"] == 1


# ---------------------------------------------------------------------------
# Rejection paths (honest return values, no silent telemetry)
# ---------------------------------------------------------------------------


def test_invalid_outcome_is_rejected(skills_home):
    from tools import skill_usage as su

    _write_skill(skills_home, "demo-skill")
    assert su.record_outcome("demo-skill", "maybe") is False
    assert su.record_outcome("demo-skill", "") is False
    assert _raw_record(skills_home, "demo-skill") == {}


def test_outcome_refused_for_protected_builtin(skills_home):
    """Protected built-ins are never curator-managed — no outcome telemetry."""
    from tools import skill_usage as su

    assert su.is_protected_builtin("plan") is True
    assert su.record_outcome("plan", "hurt") is False
    assert _raw_record(skills_home, "plan") == {}


def test_outcome_refused_for_empty_name(skills_home):
    from tools import skill_usage as su

    assert su.record_outcome("", "helped") is False
