"""Curator effectiveness policy — outcomes outrank the inactivity clock.

Fase 2c of `.hermes/plans/2026-09-22_174556-autoaprendizaje-verificado-core.md`.

Before this, `apply_automatic_transitions` moved skills active → stale →
archived purely on timestamps: a skill used 40 times that failed every time
aged exactly like one that solved 40 tasks. These tests pin the two verdicts
that change that, plus the invariant that a skill with NO recorded outcomes
behaves exactly as it did before.
"""

from __future__ import annotations

import importlib
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


@pytest.fixture
def curator_env(tmp_path, monkeypatch):
    """Isolated ALICE_HOME + freshly reloaded curator + skill_usage modules."""
    home = tmp_path / ".alice"
    (home / "skills").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("ALICE_HOME", str(home))

    import tools.skill_usage as usage
    importlib.reload(usage)
    import agent.curator as curator
    importlib.reload(curator)

    monkeypatch.setattr(curator, "_run_llm_review", lambda prompt: "llm-stub")
    monkeypatch.setattr(curator, "_load_config", lambda: {})
    monkeypatch.setattr(usage, "_prune_builtins_enabled", lambda: False)

    yield {"home": home, "curator": curator, "usage": usage}

    for t in threading.enumerate():
        if t.name == "curator-review" and t.is_alive():
            t.join(timeout=10.0)


def _write_skill(skills_dir: Path, name: str) -> Path:
    d = skills_dir / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\n# body\n",
        encoding="utf-8",
    )
    return d


def _seed(env, name: str, *, helped=0, hurt=0, use=1, days_ago=0, state=None, pinned=False):
    """Write a usage record with the given outcome signal, bypassing the API.

    Seeding the sidecar directly is deliberate: these tests are about the
    curator's READING of the signal, and going through record_outcome would
    only re-test Fase 1.
    """
    u = env["usage"]
    ts = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()
    rec = u._empty_record()
    rec["created_by"] = "agent"
    rec["use_count"] = use
    rec["last_used_at"] = ts
    rec["created_at"] = ts
    rec["helped_count"] = helped
    rec["hurt_count"] = hurt
    rec["pinned"] = pinned
    if state:
        rec["state"] = state
    data = u.load_usage()
    data[name] = rec
    u.save_usage(data)


# ---------------------------------------------------------------------------
# Harmful → quarantine (visible, reversible, not silent removal)
# ---------------------------------------------------------------------------


def test_harmful_skill_is_quarantined_despite_recent_use(curator_env):
    """A skill that keeps failing must not stay active just because it's new."""
    c, u = curator_env["curator"], curator_env["usage"]
    _write_skill(curator_env["home"] / "skills", "misleading")
    _seed(curator_env, "misleading", helped=0, hurt=3, use=3, days_ago=0)

    counts = c.apply_automatic_transitions()

    assert counts["quarantined"] == 1
    assert u.get_record("misleading")["state"] == "stale"


def test_harmful_skill_is_not_archived_even_past_the_archive_window(curator_env):
    """Quarantine is a fix-or-merge candidate, not a silent removal."""
    c, u = curator_env["curator"], curator_env["usage"]
    skills_dir = curator_env["home"] / "skills"
    skill_dir = _write_skill(skills_dir, "harmful-old")
    _seed(curator_env, "harmful-old", helped=0, hurt=4, use=4, days_ago=200)

    counts = c.apply_automatic_transitions()

    assert counts["archived"] == 0
    assert skill_dir.exists(), "a quarantined skill must stay visible for review"
    assert u.get_record("harmful-old")["state"] == "stale"


def test_harmful_requires_zero_observed_successes(curator_env):
    """hurt alone is not a verdict — a skill that sometimes works is not harmful."""
    c, u = curator_env["curator"], curator_env["usage"]
    _write_skill(curator_env["home"] / "skills", "mixed")
    _seed(curator_env, "mixed", helped=1, hurt=5, use=6, days_ago=0)

    counts = c.apply_automatic_transitions()

    assert counts["quarantined"] == 0
    assert u.get_record("mixed")["state"] == "active"


def test_pinned_harmful_skill_is_never_touched(curator_env):
    """Pin is the user's opt-out and outranks every automatic verdict."""
    c, u = curator_env["curator"], curator_env["usage"]
    _write_skill(curator_env["home"] / "skills", "pinned-bad")
    _seed(curator_env, "pinned-bad", helped=0, hurt=9, use=9, days_ago=0, pinned=True)

    counts = c.apply_automatic_transitions()

    assert counts["quarantined"] == 0
    assert u.get_record("pinned-bad")["state"] == "active"


# ---------------------------------------------------------------------------
# Proven → idleness stops being a reason to prune
# ---------------------------------------------------------------------------


def test_proven_skill_survives_the_archive_window(curator_env):
    """40 sessions of observed success must beat 200 days of idleness."""
    c, u = curator_env["curator"], curator_env["usage"]
    skills_dir = curator_env["home"] / "skills"
    skill_dir = _write_skill(skills_dir, "proven")
    _seed(curator_env, "proven", helped=6, hurt=0, use=6, days_ago=200)

    counts = c.apply_automatic_transitions()

    assert counts["protected_by_effectiveness"] == 1
    assert counts["archived"] == 0
    assert skill_dir.exists()
    assert u.get_record("proven")["state"] == "active"


def test_proven_skill_is_reactivated_from_stale(curator_env):
    c, u = curator_env["curator"], curator_env["usage"]
    _write_skill(curator_env["home"] / "skills", "proven-stale")
    _seed(
        curator_env, "proven-stale",
        helped=8, hurt=1, use=9, days_ago=45, state="stale",
    )

    counts = c.apply_automatic_transitions()

    assert counts["reactivated"] == 1
    assert u.get_record("proven-stale")["state"] == "active"


def test_proven_needs_a_success_rate_not_just_a_count(curator_env):
    """5 successes out of 8 decisive outcomes (62.5%) is not 'proven'."""
    c, u = curator_env["curator"], curator_env["usage"]
    skills_dir = curator_env["home"] / "skills"
    skill_dir = _write_skill(skills_dir, "coin-flip")
    _seed(curator_env, "coin-flip", helped=5, hurt=3, use=8, days_ago=200)

    counts = c.apply_automatic_transitions()

    assert counts["protected_by_effectiveness"] == 0
    assert counts["archived"] == 1
    assert not skill_dir.exists()


def test_proven_requires_enough_evidence(curator_env):
    """2 successes at 100% is not yet proof (threshold is observation count)."""
    c, u = curator_env["curator"], curator_env["usage"]
    skills_dir = curator_env["home"] / "skills"
    _write_skill(skills_dir, "thin-evidence")
    _seed(curator_env, "thin-evidence", helped=2, hurt=0, use=2, days_ago=200)

    counts = c.apply_automatic_transitions()

    assert counts["protected_by_effectiveness"] == 0
    assert counts["archived"] == 1


# ---------------------------------------------------------------------------
# Invariant: no outcomes recorded → identical behaviour to before
# ---------------------------------------------------------------------------


def test_skills_without_outcomes_keep_the_previous_time_behaviour(curator_env):
    """The whole feature must be inert until something records an outcome."""
    c, u = curator_env["curator"], curator_env["usage"]
    skills_dir = curator_env["home"] / "skills"
    _write_skill(skills_dir, "plain-old")
    _write_skill(skills_dir, "plain-new")
    _seed(curator_env, "plain-old", helped=0, hurt=0, use=1, days_ago=200)
    _seed(curator_env, "plain-new", helped=0, hurt=0, use=1, days_ago=0)

    counts = c.apply_automatic_transitions()

    assert counts["archived"] == 1
    assert counts["quarantined"] == 0
    assert counts["protected_by_effectiveness"] == 0
    assert u.get_record("plain-old")["state"] == "archived"
    assert u.get_record("plain-new")["state"] == "active"


# ---------------------------------------------------------------------------
# Policy helpers
# ---------------------------------------------------------------------------


def test_is_harmful_boundary(curator_env):
    from agent import curator as c

    assert c.is_harmful({"helped": 0, "hurt": c.EFFECTIVENESS_HURT_QUARANTINE_MIN}) is True
    assert c.is_harmful({"helped": 0, "hurt": c.EFFECTIVENESS_HURT_QUARANTINE_MIN - 1}) is False
    assert c.is_harmful({"helped": 1, "hurt": 99}) is False
    assert c.is_harmful({}) is False


def test_is_proven_boundary(curator_env):
    from agent import curator as c

    assert c.is_proven({"helped": 5, "hurt": 0, "rate": 1.0}) is True
    assert c.is_proven({"helped": 4, "hurt": 0, "rate": 1.0}) is False
    assert c.is_proven({"helped": 9, "hurt": 9, "rate": 0.5}) is False
    assert c.is_proven({"helped": 5, "hurt": 0, "rate": None}) is False


# ---------------------------------------------------------------------------
# The signal reaches the LLM reviewer
# ---------------------------------------------------------------------------


def test_candidate_list_shows_effectiveness(curator_env):
    c = curator_env["curator"]
    _write_skill(curator_env["home"] / "skills", "rated")
    _seed(curator_env, "rated", helped=1, hurt=2, use=3, days_ago=0)

    listing = c._render_candidate_list()

    assert "helped=1" in listing
    assert "hurt=2" in listing
    assert "last_outcome=none" in listing  # seeded directly, no last_outcome set


def test_review_prompt_explains_the_effectiveness_signal():
    """The LLM pass must be told what helped/hurt mean (and what it does NOT
    override — rule 4's content-over-counters bar for consolidation)."""
    from agent.curator import CURATOR_REVIEW_PROMPT

    lower = CURATOR_REVIEW_PROMPT.lower()
    assert "helped" in lower and "hurt" in lower
    assert "liability" in lower
    assert "proven" in lower
    assert "rule 4" in lower
