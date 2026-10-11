"""The review/curator prompts must carry the delta-lesson discipline.

Fase 3b of `.hermes/plans/2026-09-22_174556-autoaprendizaje-verificado-core.md`.

Behavioral assertions on instructions, not snapshots of prompt text: what
matters is that the fork is told to APPEND a lesson instead of rewriting the
body, and that the curator is told to merge duplicates and promote a
twice-confirmed lesson into the Procedure.
"""

from agent.background_review import _COMBINED_REVIEW_PROMPT, _SKILL_REVIEW_PROMPT
from agent.curator import CURATOR_REVIEW_PROMPT


def test_skill_review_prompt_prefers_the_delta_write():
    lower = _SKILL_REVIEW_PROMPT.lower()
    assert "add_lesson" in _SKILL_REVIEW_PROMPT
    assert "delta over rewrite" in lower
    assert "## lessons" in lower
    # The failure mode must be named, not implied.
    assert "rewrite" in lower and "earlier lesson" in lower


def test_skill_review_prompt_requires_reading_before_appending():
    """The append is refused without a prior skill_view — say so."""
    lower = _SKILL_REVIEW_PROMPT.lower()
    assert "skill_view" in lower
    assert "refused" in lower


def test_combined_review_prompt_also_carries_it():
    lower = _COMBINED_REVIEW_PROMPT.lower()
    assert "add_lesson" in _COMBINED_REVIEW_PROMPT
    assert "delta over rewrite" in lower
    assert "## lessons" in lower


def test_curator_prompt_explains_lesson_merging_and_promotion():
    lower = CURATOR_REVIEW_PROMPT.lower()
    assert "## lessons" in lower
    assert "bullets" in lower
    # merge duplicates…
    assert "merge" in lower
    # …promote a twice-confirmed lesson into the Procedure…
    assert "promote" in lower and "procedure" in lower
    # …and never delete the section itself.
    assert "never delete the section" in lower


def test_curator_prompt_keeps_numbering_coherent():
    """The new rule sits inside the numbered hard-rules block."""
    assert "4b." in CURATOR_REVIEW_PROMPT
    assert "4c." in CURATOR_REVIEW_PROMPT
    assert "5." in CURATOR_REVIEW_PROMPT
