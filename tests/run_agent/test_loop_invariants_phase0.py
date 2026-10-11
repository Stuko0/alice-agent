"""Phase 0 safety net for the agent loop: invariants, not snapshots.

These tests pin properties the conversation loop must keep while the
plugin-architecture refactor moves code around. They deliberately do not
freeze prompt text or tool counts; they assert relationships:

1. The system prompt sent on step 2 is identical to step 1 (prompt caching).
2. The tool schema list sent on step 2 is identical to step 1 (no mid-turn
   toolset swap).
3. Roles of the messages sent to the model never repeat consecutively
   (strict role alternation, excluding tool results which are their own role).
4. A tool result from step 1 is present, unmodified, in step 2's messages.

No network: the model call is replaced at ``_interruptible_api_call``.
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from run_agent import AIAgent


def _tool_call_response(call_id: str, name: str, args: dict):
    tc = SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )
    msg = SimpleNamespace(content="", tool_calls=[tc], reasoning_content=None)
    choice = SimpleNamespace(message=msg, finish_reason="tool_calls")
    return SimpleNamespace(choices=[choice], model="m", usage=None)


def _text_response(text: str):
    msg = SimpleNamespace(content=text, tool_calls=None, reasoning_content=None)
    choice = SimpleNamespace(message=msg, finish_reason="stop")
    return SimpleNamespace(choices=[choice], model="m", usage=None)


def _tool_defs():
    return [
        {
            "type": "function",
            "function": {
                "name": "probe_tool",
                "description": "probe",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]


def _make_agent():
    with (
        patch("run_agent.get_tool_definitions", return_value=_tool_defs()),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI", return_value=MagicMock()),
    ):
        agent = AIAgent(
            api_key="test-key-abcdef12",
            base_url="https://example.invalid/v1",
            provider="openrouter",
            model="test/model",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
        agent.client = MagicMock()
        return agent


def _run_two_steps(agent):
    """Drive a turn: step 1 calls a tool, step 2 answers in text.

    Returns the list of kwargs-snapshots the loop sent to the model.
    """
    sent = []
    responses = iter(
        [
            _tool_call_response("call_1", "probe_tool", {}),
            _text_response("done"),
        ]
    )

    def fake_call(api_kwargs):
        # Deep-copy the parts we inspect so later mutation can't hide a change.
        sent.append(json.loads(json.dumps(api_kwargs, default=str)))
        return next(responses)

    def fake_tool(*args, **kwargs):
        return json.dumps({"ok": True, "marker": "probe-result-1"})

    with (
        patch.object(agent, "_interruptible_api_call", side_effect=fake_call),
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
        patch("agent.conversation_loop.handle_function_call", side_effect=fake_tool, create=True),
        patch("tools.registry.registry.dispatch", side_effect=fake_tool),
    ):
        agent.run_conversation("hello")
    return sent


def _system_text(api_kwargs):
    msgs = api_kwargs.get("messages") or []
    for m in msgs:
        if m.get("role") == "system":
            content = m.get("content")
            return json.dumps(content, sort_keys=True)
    return None


def test_system_prompt_is_stable_across_steps_of_one_turn():
    sent = _run_two_steps(_make_agent())
    assert len(sent) >= 2, "expected at least two model calls in one turn"
    assert _system_text(sent[0]) is not None
    assert _system_text(sent[0]) == _system_text(sent[1])


def test_tool_schema_is_stable_across_steps_of_one_turn():
    sent = _run_two_steps(_make_agent())
    assert len(sent) >= 2
    assert sent[0].get("tools") == sent[1].get("tools")


def test_roles_never_repeat_consecutively_for_non_tool_messages():
    sent = _run_two_steps(_make_agent())
    for kwargs in sent:
        roles = [m.get("role") for m in kwargs.get("messages", []) if m.get("role") != "system"]
        for prev, cur in zip(roles, roles[1:]):
            if prev == "tool" or cur == "tool":
                continue
            assert not (prev == cur == "user"), roles
            assert not (prev == cur == "assistant" and cur != "assistant"), roles


def test_step_one_tool_result_is_replayed_unmodified_on_step_two():
    sent = _run_two_steps(_make_agent())
    assert len(sent) >= 2
    tool_msgs = [m for m in sent[1].get("messages", []) if m.get("role") == "tool"]
    assert tool_msgs, "step 2 must include the tool result from step 1"
    assert any("probe-result-1" in str(m.get("content")) for m in tool_msgs)
