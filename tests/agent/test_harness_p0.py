"""P0 harness work: narrow core, deferred opt-in tools, output budget, prompt.

These are behaviour contracts, not snapshots: they assert relationships the
harness must keep (core is a subset of what platforms enable; deferral never
loses a tool; the per-turn budget fires only past the limit).
"""

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from agent.prompt_builder import PARALLEL_TOOL_CALL_GUIDANCE  # noqa: E402
from alice_cli.config import DEFAULT_CONFIG  # noqa: E402
from tools.budget_config import (  # noqa: E402
    DEFAULT_RESULT_SIZE_CHARS,
    DEFAULT_TURN_BUDGET_CHARS,
    budget_for_context_window,
)
from tools.tool_result_storage import enforce_turn_budget  # noqa: E402
from toolsets import (  # noqa: E402
    _ALICE_ALL_TOOLS,
    _ALICE_CORE_TOOLS,
    _ALICE_STANDARD_TOOLS,
    resolve_toolset,
)

ESSENTIALS = {
    "terminal",
    "process",
    "read_file",
    "write_file",
    "patch",
    "search_files",
    "web_search",
    "web_extract",
    "todo",
    "memory",
    "skills_list",
    "skill_view",
    "skill_manage",
    "execute_code",
    "delegate_task",
    "clarify",
}

# Capabilities that used to ride in the always-on core. They stay available on
# every platform — they are just deferrable now.
HEAVY = (
    "browser_navigate",
    "browser_cdp",
    "computer_use",
    "text_to_speech",
    "image_generate",
    "session_search",
)


class TestCoreSurface:
    def test_core_is_the_narrow_waist(self):
        assert ESSENTIALS <= set(_ALICE_CORE_TOOLS)
        for heavy in HEAVY:
            assert heavy not in _ALICE_CORE_TOOLS, heavy
            assert heavy in _ALICE_STANDARD_TOOLS
        assert len(_ALICE_CORE_TOOLS) <= 20

    def test_core_and_standard_are_disjoint(self):
        assert not (set(_ALICE_CORE_TOOLS) & set(_ALICE_STANDARD_TOOLS))
        assert set(_ALICE_ALL_TOOLS) == set(_ALICE_CORE_TOOLS) | set(
            _ALICE_STANDARD_TOOLS
        )

    def test_platforms_keep_every_capability(self):
        # Platforms that used to inherit the old always-on core keep it all.
        for platform in (
            "alice-cli",
            "alice-telegram",
            "alice-discord",
            "alice-slack",
            "alice-whatsapp",
            "alice-cron",
        ):
            tools = set(resolve_toolset(platform))
            assert set(_ALICE_CORE_TOOLS) <= tools, platform
            for capability in HEAVY:
                assert capability in tools, (platform, capability)

        # Deliberately narrower postures still keep the working essentials
        # (ACP has no interactive clarify UI, API server no clarify either).
        working_set = {
            "terminal",
            "read_file",
            "write_file",
            "patch",
            "search_files",
            "web_search",
            "execute_code",
        }
        for platform in ("alice-acp", "alice-api-server"):
            assert working_set <= set(resolve_toolset(platform)), platform

    def test_coding_posture_keeps_capability_but_defers_it(self):
        import model_tools  # noqa: F401  (triggers tool discovery)

        from tools.tool_search import is_deferrable_tool_name

        tools = set(resolve_toolset("coding"))

        assert {"terminal", "patch", "execute_code", "browser_navigate"} <= tools
        # Present, but not paid for on every call.
        assert is_deferrable_tool_name("browser_navigate") is True


class TestDeferral:
    def test_platform_specific_tools_are_not_universal(self):
        # Feishu/discord tools ship in their own toolsets; the platform
        # bundles must not absorb them (they leaked in an earlier revision).
        for name in ("feishu_doc_read", "discord_admin", "yb_send_dm"):
            assert name not in _ALICE_ALL_TOOLS, name

    def test_opt_in_tools_are_deferrable_and_core_is_not(self):
        # Importing model_tools triggers tool discovery, which is what fills the
        # registry that classification consults.
        import model_tools  # noqa: F401

        from tools.tool_search import is_deferrable_tool_name

        assert is_deferrable_tool_name("browser_navigate") is True
        assert is_deferrable_tool_name("feishu_doc_read") is True
        assert is_deferrable_tool_name("read_file") is False
        assert is_deferrable_tool_name("terminal") is False

    def test_absolute_floor_activates_on_large_windows(self):
        from tools.tool_search import ToolSearchConfig, should_activate

        cfg = ToolSearchConfig.from_raw(None)

        # 4k tokens of optional tools is worth deferring even in a 1M window.
        assert should_activate(cfg, 4_000, 1_000_000) is True
        # Tiny catalogues stay inline.
        assert should_activate(cfg, 500, 1_000_000) is False

    def test_floor_can_be_disabled(self):
        from tools.tool_search import ToolSearchConfig, should_activate

        cfg = ToolSearchConfig.from_raw(
            {"min_deferrable_tokens": 0, "threshold_pct": 50}
        )

        assert should_activate(cfg, 4_000, 100_000) is False  # 50% of 100k = 50k
        assert should_activate(cfg, 60_000, 100_000) is True


def _schema_size(tools):
    return len(json.dumps(tools)) // 4


class TestAssembledSchema:
    """Integration: what the model actually receives for a default install."""

    def test_default_schema_defers_opt_in_tools(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))

        import model_tools

        tools = model_tools.get_tool_definitions()
        names = {t["function"]["name"] for t in tools}
        tokens = _schema_size(tools)

        capsys.readouterr()

        # The bridge replaces the opt-in catalogue.
        assert {"tool_search", "tool_describe", "tool_call"} <= names
        assert "browser_navigate" not in names
        assert "feishu_doc_read" not in names
        # The essentials stay directly callable.
        assert {"terminal", "read_file", "patch", "execute_code"} <= names
        # And the prompt is materially smaller than the 34-tool / ~14k baseline.
        assert tokens < 11_000, tokens
        assert len(names) <= 22, len(names)

    def test_coding_posture_is_thin_but_not_crippled(
        self, monkeypatch, tmp_path, capsys
    ):
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))

        import model_tools

        tools = model_tools.get_tool_definitions(
            enabled_toolsets=["coding"], quiet_mode=True
        )
        names = {t["function"]["name"] for t in tools}

        capsys.readouterr()

        assert {"terminal", "patch", "read_file", "execute_code", "todo"} <= names
        # Browser exists in the coding toolset, but its schema is deferred.
        assert "browser_navigate" not in names
        assert len(names) <= 22, len(names)


class TestTurnOutputBudget:
    """Layer 3 (tools/tool_result_storage.py) is the per-turn cap."""

    def test_defaults_are_sized_for_a_128k_window(self):
        # One result ≤ ~12% of a 128K-token window; a whole turn ≤ ~25%.
        assert DEFAULT_RESULT_SIZE_CHARS <= 128_000 * 4 * 0.15
        assert DEFAULT_TURN_BUDGET_CHARS <= 128_000 * 4 * 0.30

    def test_budget_scales_down_with_the_window(self):
        small = budget_for_context_window(32_000)
        big = budget_for_context_window(1_000_000)

        assert small.turn_budget < DEFAULT_TURN_BUDGET_CHARS
        assert big.turn_budget == DEFAULT_TURN_BUDGET_CHARS
        assert big.default_result_size == DEFAULT_RESULT_SIZE_CHARS
        assert small.turn_budget > small.default_result_size

    def test_normal_turn_passes_through_untouched(self):
        msgs = [
            {"role": "tool", "content": "a" * 1_000},
            {"role": "tool", "content": "b" * 1_000},
        ]
        before = [m["content"] for m in msgs]

        enforce_turn_budget(msgs, env=None, config=budget_for_context_window(128_000))

        assert [m["content"] for m in msgs] == before

    def test_oversized_turn_persists_largest_results(self):
        # 3 x 10K chars: each fits under the per-result threshold, but the
        # turn total (30K) exceeds the 24K turn budget of a 20K-token model.
        budget = budget_for_context_window(20_000)
        assert budget.default_result_size > 10_000
        assert budget.turn_budget == 24_000

        msgs = [
            {"role": "tool", "content": "x" * 10_000, "tool_call_id": f"c{i}"}
            for i in range(3)
        ]

        enforce_turn_budget(msgs, env=None, config=budget)

        total = sum(len(m["content"]) for m in msgs)
        assert total <= budget.turn_budget, total
        # At least one result was replaced by its preview (not silently lost).
        assert any("Truncated" in m["content"] or "persisted" in m["content"]
                   for m in msgs)

    def test_executor_enforces_the_turn_budget_end_to_end(
        self, monkeypatch, tmp_path
    ):
        """Integration: the real tool loop hands its turn's messages to Layer 3."""
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))

        import run_agent

        def _tool_call(name, arguments, call_id):
            return SimpleNamespace(
                id=call_id,
                type="function",
                function=SimpleNamespace(name=name, arguments=arguments),
            )

        def _assistant_msg(tool_calls):
            return SimpleNamespace(content="", tool_calls=tool_calls)

        with (
            patch("run_agent.get_tool_definitions", return_value=[]),
            patch("run_agent.check_toolset_requirements", return_value={}),
            patch("run_agent.OpenAI"),
        ):
            agent = run_agent.AIAgent(
                api_key="test-key-0000000000",
                base_url="http://127.0.0.1:1/v1",
                quiet_mode=True,
                skip_context_files=True,
                skip_memory=True,
            )
        agent.client = MagicMock()
        # A 20K-token window -> 24K-char turn budget, 12K-char per result.
        agent.context_compressor = SimpleNamespace(context_length=20_000)

        calls = [
            _tool_call("web_search", '{"q":"a"}', "c1"),
            _tool_call("web_search", '{"q":"b"}', "c2"),
            _tool_call("web_search", '{"q":"c"}', "c3"),
        ]
        messages = []

        with patch("run_agent.handle_function_call", return_value="z" * 10_000):
            agent._execute_tool_calls_concurrent(_assistant_msg(calls), messages, "task")

        tool_msgs = [m for m in messages if m["role"] == "tool"]
        assert len(tool_msgs) == 3
        total = sum(len(m["content"]) for m in tool_msgs)
        assert total <= budget_for_context_window(20_000).turn_budget, total


class TestCompactionPolicy:
    def test_compacts_late_enough_to_keep_the_cache(self):
        assert DEFAULT_CONFIG["compression"]["threshold"] >= 0.7


class TestPromptTeaching:
    def test_parallel_guidance_teaches_execute_code_batching(self):
        text = PARALLEL_TOOL_CALL_GUIDANCE

        assert "execute_code" in text
        assert "round-trip" in text
        assert "three or more" in text
