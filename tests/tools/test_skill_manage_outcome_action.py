"""skill_manage(action="record_outcome") — the effectiveness write path.

Fase 2a of `.hermes/plans/2026-09-22_174556-autoaprendizaje-verificado-core.md`.

The load-bearing contract here is CACHE SAFETY: recording an outcome changes no
skill text, so it must not invalidate the skills snapshot (which would rebuild
the system prompt mid-conversation). The prompt-patch test below is the
positive control that proves the assertion can actually fail.
"""

import json
from pathlib import Path

import pytest


@pytest.fixture
def skills_home(tmp_path, monkeypatch):
    home = tmp_path / ".alice"
    (home / "skills").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("ALICE_HOME", str(home))
    return home


def _write_skill(skills_home: Path, name: str) -> Path:
    d = skills_home / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\n# body\n\nbody\n",
        encoding="utf-8",
    )
    return d


def _payload(raw: str) -> dict:
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------


def test_record_outcome_action_persists_and_reports(skills_home):
    from tools.skill_manager_tool import skill_manage

    _write_skill(skills_home, "demo-skill")
    res = _payload(skill_manage(action="record_outcome", name="demo-skill", outcome="helped"))

    assert res["success"] is True
    assert res["outcome"] == "helped"
    assert res["helped_count"] == 1
    assert res["hurt_count"] == 0
    assert res["effectiveness"]["rate"] == 1.0

    from tools import skill_usage as su

    assert su.get_record("demo-skill")["helped_count"] == 1


def test_record_outcome_action_requires_outcome(skills_home):
    from tools.skill_manager_tool import skill_manage

    _write_skill(skills_home, "demo-skill")
    res = _payload(skill_manage(action="record_outcome", name="demo-skill"))

    assert res["success"] is False
    assert "outcome is required" in res["error"]


def test_record_outcome_action_rejects_non_managed_skill(skills_home):
    """A protected built-in is not curator-managed — refuse, don't fake success."""
    from tools.skill_manager_tool import skill_manage

    res = _payload(skill_manage(action="record_outcome", name="plan", outcome="hurt"))

    assert res["success"] is False
    assert "curator-managed" in res["error"]


# ---------------------------------------------------------------------------
# Cache safety
# ---------------------------------------------------------------------------


def test_record_outcome_does_not_clear_skills_prompt_cache(skills_home, monkeypatch):
    """Telemetry must never invalidate the conversation's cached prefix."""
    import agent.prompt_builder as pb
    from tools.skill_manager_tool import skill_manage

    _write_skill(skills_home, "demo-skill")
    calls = []
    monkeypatch.setattr(pb, "clear_skills_system_prompt_cache", lambda **kw: calls.append(kw))

    res = _payload(skill_manage(action="record_outcome", name="demo-skill", outcome="neutral"))

    assert res["success"] is True
    assert calls == [], "record_outcome must not clear the skills system-prompt cache"


def test_content_actions_still_clear_the_cache(skills_home, monkeypatch):
    """Positive control for the test above: a content write DOES clear it."""
    import agent.prompt_builder as pb
    from tools.skill_manager_tool import skill_manage

    _write_skill(skills_home, "demo-skill")
    calls = []
    monkeypatch.setattr(pb, "clear_skills_system_prompt_cache", lambda **kw: calls.append(kw))

    res = _payload(
        skill_manage(
            action="patch",
            name="demo-skill",
            old_string="# body",
            new_string="# body patched",
        )
    )

    assert res["success"] is True, res
    assert calls, "a content-changing action must still invalidate the skills snapshot"


# ---------------------------------------------------------------------------
# Never staged by the write-approval gate (nothing to review)
# ---------------------------------------------------------------------------


def test_record_outcome_bypasses_the_write_gate(skills_home):
    from tools.skill_manager_tool import _apply_skill_write_gate

    assert _apply_skill_write_gate("record_outcome", "demo-skill", outcome="helped") is None


# ---------------------------------------------------------------------------
# Schema surface
# ---------------------------------------------------------------------------


def test_schema_exposes_the_outcome_action():
    from tools.skill_manager_tool import SKILL_MANAGE_SCHEMA

    props = SKILL_MANAGE_SCHEMA["parameters"]["properties"]
    assert "record_outcome" in props["action"]["enum"]
    assert props["outcome"]["enum"] == ["helped", "hurt", "neutral"]
    assert "outcome_note" in props


def test_schema_marks_no_outcome_params_as_required():
    """Outcome args must stay optional so existing calls keep validating."""
    from tools.skill_manager_tool import SKILL_MANAGE_SCHEMA

    assert SKILL_MANAGE_SCHEMA["parameters"]["required"] == ["action", "name"]
