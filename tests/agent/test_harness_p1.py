"""P1 harness work: plan mode (read-only), read-only subagent presets, LSP.

These tests pin the *contract* of each feature: plan mode cannot be bypassed
by any toolset selection, presets are read-only by construction, and the LSP
tier is on by default after an edit.
"""

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from alice_cli.config import DEFAULT_CONFIG  # noqa: E402
from toolsets import resolve_toolset  # noqa: E402

WRITE_CAPABLE = ("write_file", "patch", "terminal", "execute_code", "process")
READ_ONLY = ("read_file", "search_files", "web_search", "skills_list", "todo")


def _names(tools):
    return {t["function"]["name"] for t in tools}


def _assembled(monkeypatch, tmp_path, **kwargs):
    monkeypatch.setenv("ALICE_HOME", str(tmp_path))
    import model_tools

    return model_tools.get_tool_definitions(quiet_mode=True, **kwargs)


class TestPlanModeToolset:
    def test_plan_toolset_is_read_only(self):
        tools = set(resolve_toolset("plan"))

        for name in WRITE_CAPABLE:
            assert name not in tools, name
        for name in READ_ONLY:
            assert name in tools, name

    def test_plan_mode_flag_reads_the_env(self, monkeypatch):
        from toolsets import plan_mode_active

        monkeypatch.delenv("ALICE_PLAN_MODE", raising=False)
        assert plan_mode_active() is False

        for value in ("1", "true", "YES", "on"):
            monkeypatch.setenv("ALICE_PLAN_MODE", value)
            assert plan_mode_active() is True, value

        monkeypatch.setenv("ALICE_PLAN_MODE", "0")
        assert plan_mode_active() is False


class TestPlanModeAssembly:
    def test_plan_mode_strips_write_tools(self, monkeypatch, tmp_path):
        monkeypatch.setenv("ALICE_PLAN_MODE", "1")

        tools = _assembled(monkeypatch, tmp_path)
        names = _names(tools)

        for name in WRITE_CAPABLE:
            assert name not in names, name
        # Credential-free read tools must survive the filter. (web_search is in
        # the `plan` toolset but its check_fn needs an API key, which the
        # hermetic test environment does not provide.)
        for name in ("read_file", "search_files", "todo", "skills_list"):
            assert name in names, name
        # Never empty: the model must still be able to investigate.
        assert len(names) >= 3

    def test_plan_mode_cannot_be_bypassed_by_an_explicit_toolset(
        self, monkeypatch, tmp_path
    ):
        """The gate lives in get_tool_definitions, not in each caller."""
        monkeypatch.setenv("ALICE_PLAN_MODE", "1")

        for toolsets in (["alice-cli"], ["coding"], ["file", "terminal"]):
            names = _names(_assembled(monkeypatch, tmp_path, enabled_toolsets=toolsets))
            assert "write_file" not in names, toolsets
            assert "patch" not in names, toolsets
            assert "terminal" not in names, toolsets

    def test_raw_catalogue_is_also_filtered(self, monkeypatch, tmp_path):
        """The tool_search bridge reads the raw catalogue — it must obey too."""
        monkeypatch.setenv("ALICE_PLAN_MODE", "1")

        names = _names(
            _assembled(monkeypatch, tmp_path, skip_tool_search_assembly=True)
        )
        assert "write_file" not in names
        assert "read_file" in names

    def test_tool_cache_does_not_leak_across_modes(self, monkeypatch, tmp_path):
        """quiet_mode memoizes per (toolsets, config, plan-mode). Prove it."""
        monkeypatch.setenv("ALICE_HOME", str(tmp_path))
        import model_tools

        monkeypatch.delenv("ALICE_PLAN_MODE", raising=False)
        normal = _names(model_tools.get_tool_definitions(quiet_mode=True))

        monkeypatch.setenv("ALICE_PLAN_MODE", "1")
        planned = _names(model_tools.get_tool_definitions(quiet_mode=True))

        assert "write_file" in normal
        assert "write_file" not in planned

    def test_plan_guidance_is_instructive(self):
        from agent.prompt_builder import PLAN_MODE_GUIDANCE

        assert "read-only" in PLAN_MODE_GUIDANCE.lower()
        assert "plan" in PLAN_MODE_GUIDANCE.lower()
        assert "file:line" in PLAN_MODE_GUIDANCE
        assert len(PLAN_MODE_GUIDANCE) < 1200


class TestPlanModeCli:
    def test_plan_flag_parses_and_is_inherited(self):
        from alice_cli._parser import build_top_level_parser

        parser, _sub, _chat = build_top_level_parser()
        args = parser.parse_args(["--plan"])
        assert args.plan is True

        actions = [
            a for a in parser._actions if getattr(a, "dest", "") == "plan"
        ]
        assert actions and getattr(actions[0], "inherit_on_relaunch", False)

        # Default is off.
        assert parser.parse_args([]).plan is False

    def test_flag_sets_the_environment(self, monkeypatch):
        from types import SimpleNamespace

        from alice_cli.main import _apply_plan_mode_env

        monkeypatch.delenv("ALICE_PLAN_MODE", raising=False)
        _apply_plan_mode_env(SimpleNamespace(plan=True))
        assert __import__("os").environ["ALICE_PLAN_MODE"] == "1"

        monkeypatch.delenv("ALICE_PLAN_MODE", raising=False)
        _apply_plan_mode_env(SimpleNamespace(plan=False))
        assert "ALICE_PLAN_MODE" not in __import__("os").environ


class TestSubagentPresets:
    def test_presets_exist_and_are_read_only(self):
        from tools.delegate_tool import SUBAGENT_PRESETS

        assert {"explore", "review"} <= set(SUBAGENT_PRESETS)
        for name, preset in SUBAGENT_PRESETS.items():
            assert preset["toolsets"] == ["plan"], name
            assert "do not modify" in preset["prompt"].lower(), name

    def test_normalize_preset(self):
        from tools.delegate_tool import _normalize_preset

        assert _normalize_preset("EXPLORE") == "explore"
        assert _normalize_preset(" review ") == "review"
        assert _normalize_preset("general") is None
        assert _normalize_preset("") is None
        assert _normalize_preset(None) is None
        assert _normalize_preset("nonsense") is None

    def test_prompt_carries_the_preset_contract(self):
        from tools.delegate_tool import _build_child_system_prompt

        prompt = _build_child_system_prompt("find the bug", preset="review")

        assert "Preset: review" in prompt
        assert "find the bug" in prompt
        assert "file:line" in prompt

    @patch("tools.delegate_tool._load_config")
    @patch("run_agent.AIAgent")
    def test_child_gets_the_plan_toolset(self, MockAgent, mock_cfg):
        """The preset pins enabled_toolsets=['plan'] on the child AIAgent."""
        from tools.delegate_tool import _build_child_agent

        mock_cfg.return_value = {"max_iterations": 50}
        MockAgent.return_value = MagicMock()

        parent = MagicMock()
        parent.base_url = "https://openrouter.ai/api/v1"
        parent.api_key = "***"
        parent.provider = "openrouter"
        parent.api_mode = "chat_completions"
        parent.model = "anthropic/claude-sonnet-4"
        parent.platform = "cli"
        parent.providers_allowed = None
        parent.providers_ignored = None
        parent.providers_order = None
        parent.provider_sort = None
        parent._session_db = None
        parent._delegate_depth = 0
        parent._active_children = []
        parent._active_children_lock = MagicMock()
        parent._print_fn = None
        parent.tool_progress_callback = None
        parent.thinking_callback = None

        _build_child_agent(
            task_index=0,
            goal="map the parser",
            context=None,
            toolsets=["terminal", "file"],
            model=None,
            max_iterations=50,
            task_count=1,
            parent_agent=parent,
            preset="explore",
        )

        kwargs = MockAgent.call_args[1]
        assert kwargs["enabled_toolsets"] == ["plan"]
        assert "Preset: explore" in kwargs["ephemeral_system_prompt"]

    def test_schema_advertises_the_preset(self):
        from tools.delegate_tool import DELEGATE_TASK_SCHEMA

        props = DELEGATE_TASK_SCHEMA["parameters"]["properties"]
        assert props["preset"]["enum"] == ["explore", "review"]
        task_props = props["tasks"]["items"]["properties"]
        assert task_props["preset"]["enum"] == ["explore", "review"]


class TestLspAfterEdits:
    def test_lsp_is_enabled_by_default(self):
        assert DEFAULT_CONFIG["lsp"]["enabled"] is True
        assert DEFAULT_CONFIG["lsp"]["wait_timeout"] > 0

    def test_local_edit_surfaces_semantic_diagnostics(self, tmp_path, monkeypatch):
        """The post-edit LSP tier is live on the default (local) backend."""
        from tools.environments.local import LocalEnvironment
        from tools.file_operations import ShellFileOperations

        fops = ShellFileOperations(LocalEnvironment(cwd=str(tmp_path)))

        class FakeService:
            def enabled_for(self, path):
                return True

            def get_diagnostics_sync(self, path, **kw):
                return [
                    {
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 0, "character": 4},
                        },
                        "severity": 1,
                        "message": "undefined name 'oops'",
                        "source": "pyright",
                    }
                ]

        monkeypatch.setattr("agent.lsp.get_service", lambda: FakeService())

        block = fops._maybe_lsp_diagnostics(
            str(tmp_path / "x.py"), pre_content="ok\n", post_content="oops\n"
        )

        assert "LSP diagnostics" in block
        assert "oops" in block


class TestAssembledSchemaNotRegressed:
    def test_plan_schema_is_small(self, monkeypatch, tmp_path):
        monkeypatch.setenv("ALICE_PLAN_MODE", "1")
        tokens = len(json.dumps(_assembled(monkeypatch, tmp_path))) // 4

        assert tokens < 8_000, tokens
