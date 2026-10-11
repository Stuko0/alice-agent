"""`add_lesson` — the delta write path for skill lessons.

Fase 3 of `.hermes/plans/2026-09-22_174556-autoaprendizaje-verificado-core.md`.

The contract: a lesson is APPENDED as a dated bullet under `## Lessons`, and
everything else in the file survives byte-for-byte. That is the whole point —
a full-body rewrite to "add" a lesson silently deletes the lessons the rewrite
didn't restate, which is how the library stops accumulating knowledge.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

FRONTMATTER = "---\nname: {name}\ndescription: test skill\n---\n\n"


@pytest.fixture
def skills_home(tmp_path, monkeypatch):
    home = tmp_path / ".alice"
    (home / "skills").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("ALICE_HOME", str(home))
    return home


def _write_skill(skills_home: Path, name: str, body: str) -> Path:
    d = skills_home / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    path = d / "SKILL.md"
    path.write_text(FRONTMATTER.format(name=name) + body, encoding="utf-8")
    return path


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


BODY = "# Demo\n\nIntro line.\n\n## Procedure\n\n1. Step one.\n2. Step two.\n\n## Verification\n\nRun `demo --check`.\n"


# ---------------------------------------------------------------------------
# Append semantics
# ---------------------------------------------------------------------------


def test_creates_the_lessons_section_when_absent(skills_home):
    from tools.skill_manager_tool import skill_manage

    path = _write_skill(skills_home, "demo", BODY)
    res = json.loads(skill_manage(action="add_lesson", name="demo", content="step two needs --force"))

    assert res["success"] is True
    text = path.read_text(encoding="utf-8")
    assert "## Lessons" in text
    assert f"- {_today()} — step two needs --force" in text
    # Everything that was there before is still there, in order.
    assert text.startswith(FRONTMATTER.format(name="demo") + BODY.rstrip("\n"))


def test_appends_inside_the_section_not_at_the_end_of_the_file(skills_home):
    """A `## Lessons` section in the middle must keep following sections below it."""
    from tools.skill_manager_tool import skill_manage

    body = (
        "# Demo\n\n## Procedure\n\n1. Step one.\n\n"
        "## Lessons\n\n- 2026-01-01 — older lesson.\n\n"
        "## Verification\n\nRun `demo --check`.\n"
    )
    path = _write_skill(skills_home, "demo", body)

    skill_manage(action="add_lesson", name="demo", content="newer lesson")
    text = path.read_text(encoding="utf-8")

    assert text.index("- 2026-01-01 — older lesson.") < text.index("newer lesson") < text.index("## Verification")
    # No second section was created.
    assert text.count("## Lessons") == 1


def test_empty_lessons_section_receives_the_bullet(skills_home):
    from tools.skill_manager_tool import skill_manage

    path = _write_skill(skills_home, "demo", "# Demo\n\n## Lessons\n\n## Verification\n\nRun it.\n")

    skill_manage(action="add_lesson", name="demo", content="first lesson")
    text = path.read_text(encoding="utf-8")

    assert "## Lessons\n\n- " in text
    assert text.index("first lesson") < text.index("## Verification")


def test_heading_variants_do_not_create_a_second_section(skills_home):
    from tools.skill_manager_tool import skill_manage

    path = _write_skill(skills_home, "demo", "# Demo\n\n## Lessons learned:\n\n- old one.\n")

    skill_manage(action="add_lesson", name="demo", content="new one")
    text = path.read_text(encoding="utf-8")

    assert text.count("## Lessons") == 1
    assert text.index("old one.") < text.index("new one")


def test_bullet_is_dated_and_whitespace_normalized(skills_home):
    from tools.skill_manager_tool import skill_manage

    path = _write_skill(skills_home, "demo", BODY)
    skill_manage(action="add_lesson", name="demo", content="  multi\nline\tlesson   ")

    text = path.read_text(encoding="utf-8")
    assert f"- {_today()} — multi line lesson\n" in text


# ---------------------------------------------------------------------------
# Rejections
# ---------------------------------------------------------------------------


def test_rejects_empty_lesson(skills_home):
    from tools.skill_manager_tool import skill_manage

    path = _write_skill(skills_home, "demo", BODY)
    before = path.read_text(encoding="utf-8")

    res = json.loads(skill_manage(action="add_lesson", name="demo", content="   "))

    assert res["success"] is False
    assert "content is required" in res["error"]
    assert path.read_text(encoding="utf-8") == before


def test_unknown_skill_errors(skills_home):
    from tools.skill_manager_tool import skill_manage

    res = json.loads(skill_manage(action="add_lesson", name="nope", content="x"))
    assert res["success"] is False


# ---------------------------------------------------------------------------
# It is a CONTENT write: telemetry + cache behave like patch, unlike
# record_outcome which must touch neither.
# ---------------------------------------------------------------------------


def test_add_lesson_clears_the_skills_cache(skills_home, monkeypatch):
    import agent.prompt_builder as pb
    from tools.skill_manager_tool import skill_manage

    _write_skill(skills_home, "demo", BODY)
    calls = []
    monkeypatch.setattr(pb, "clear_skills_system_prompt_cache", lambda **kw: calls.append(kw))

    skill_manage(action="add_lesson", name="demo", content="a lesson")

    assert calls, "a lesson changes SKILL.md, so the skills snapshot must be invalidated"


def test_add_lesson_bumps_patch_count(skills_home):
    from tools import skill_usage as su
    from tools.skill_manager_tool import skill_manage

    _write_skill(skills_home, "demo", BODY)
    skill_manage(action="add_lesson", name="demo", content="a lesson")

    assert su.get_record("demo")["patch_count"] == 1


def test_add_lesson_does_not_touch_the_outcome_signal(skills_home):
    from tools import skill_usage as su
    from tools.skill_manager_tool import skill_manage

    _write_skill(skills_home, "demo", BODY)
    skill_manage(action="add_lesson", name="demo", content="a lesson")

    rec = su.get_record("demo")
    assert rec["helped_count"] == 0 and rec["hurt_count"] == 0
    assert rec["last_outcome"] is None


# ---------------------------------------------------------------------------
# The review fork's guards apply to this action too
# ---------------------------------------------------------------------------


def test_review_fork_must_read_first(skills_home):
    from tools.skill_manager_tool import (
        _reset_background_review_read_marks,
        skill_manage,
    )
    from tools.skill_provenance import reset_current_write_origin, set_current_write_origin

    _write_skill(skills_home, "demo", BODY)
    _reset_background_review_read_marks()

    token = set_current_write_origin("background_review")
    try:
        res = json.loads(skill_manage(action="add_lesson", name="demo", content="a lesson"))
        assert res["success"] is False
        assert res.get("_read_before_write_required") is True
    finally:
        reset_current_write_origin(token)


def test_review_fork_refuses_protected_builtin(skills_home):
    from tools.skill_manager_tool import _background_review_preflight

    _write_skill(skills_home, "plan", BODY)

    from tools.skill_provenance import reset_current_write_origin, set_current_write_origin

    token = set_current_write_origin("background_review")
    try:
        guard = _background_review_preflight("add_lesson", "plan")
    finally:
        reset_current_write_origin(token)

    assert guard is not None and guard["success"] is False


def test_preflight_covers_add_lesson_for_pinned_skill(skills_home):
    """Registered in the preflight set, so pin/origin guards run before the write."""
    from tools import skill_usage as su
    from tools.skill_manager_tool import _background_review_preflight
    from tools.skill_provenance import reset_current_write_origin, set_current_write_origin

    _write_skill(skills_home, "demo", BODY)
    data = su.load_usage()
    rec = su._empty_record()
    rec["created_by"] = "agent"
    rec["pinned"] = True
    data["demo"] = rec
    su.save_usage(data)

    token = set_current_write_origin("background_review")
    try:
        guard = _background_review_preflight("add_lesson", "demo")
    finally:
        reset_current_write_origin(token)

    assert guard is not None and "pinned" in guard["error"]


# ---------------------------------------------------------------------------
# Schema surface
# ---------------------------------------------------------------------------


def test_schema_exposes_add_lesson():
    from tools.skill_manager_tool import SKILL_MANAGE_SCHEMA

    props = SKILL_MANAGE_SCHEMA["parameters"]["properties"]
    assert "add_lesson" in props["action"]["enum"]
    assert "add_lesson" in props["content"]["description"]
    assert SKILL_MANAGE_SCHEMA["parameters"]["required"] == ["action", "name"]
