"""The review summary must not report pure telemetry as library work.

Fase 2b of `.hermes/plans/2026-09-22_174556-autoaprendizaje-verificado-core.md`.

`record_outcome` writes no skill content, so surfacing it in the "the
background review did X" summary would tell the user something happened when
nothing changed. The patch case is the positive control: real content work
must still show up.
"""

from __future__ import annotations

import json

from agent.background_review import summarize_background_review_actions


def _call(call_id: str, name: str, args: dict) -> dict:
    return {
        "role": "assistant",
        "tool_calls": [
            {"id": call_id, "function": {"name": name, "arguments": json.dumps(args)}}
        ],
    }


def _result(call_id: str, payload: dict) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": json.dumps(payload)}


def test_review_summary_hides_record_outcome():
    messages = [
        _call("t1", "skill_manage", {"action": "record_outcome", "name": "demo", "outcome": "helped"}),
        _result(
            "t1",
            {
                "success": True,
                "name": "demo",
                "outcome": "helped",
                "message": "recorded 'helped' for 'demo' (helped=1, hurt=0)",
            },
        ),
    ]

    assert summarize_background_review_actions(messages, [], "verbose") == []
    assert summarize_background_review_actions(messages, [], "on") == []


def test_review_summary_still_reports_real_skill_work():
    messages = [
        _call(
            "t1",
            "skill_manage",
            {
                "action": "patch",
                "name": "demo",
                "old_string": "step 3: run it",
                "new_string": "step 3: run it with --force",
            },
        ),
        _result("t1", {"success": True, "message": "patched demo"}),
    ]

    actions = summarize_background_review_actions(messages, [], "verbose")

    assert actions, "a real patch must still be surfaced"
    assert any("demo" in a for a in actions)


def test_review_summary_hides_outcome_but_keeps_sibling_patch():
    messages = [
        _call("t1", "skill_manage", {"action": "record_outcome", "name": "demo", "outcome": "hurt"}),
        _result("t1", {"success": True, "message": "recorded 'hurt' for 'demo' (helped=1, hurt=1)"}),
        _call("t2", "skill_manage", {"action": "patch", "name": "demo", "old_string": "a", "new_string": "b"}),
        _result("t2", {"success": True, "message": "patched demo"}),
    ]

    actions = summarize_background_review_actions(messages, [], "verbose")

    assert len(actions) == 1
    assert "recorded" not in actions[0]
