"""Tests for the __PROT_NOUS_LYDIA__-3/4 non-agentic warning detector.

Prior to this check, the warning fired on any model whose name contained
``"alice"`` anywhere (case-insensitive). That false-positived on unrelated
local Modelfiles such as ``alice-brain:qwen3-14b-ctx16k`` — a tool-capable
Qwen3 wrapper that happens to live under the "alice" tag namespace.

``is___PROT_NOUS_LYDIA___non_agentic`` should only match the actual Stuko
Alice-3 / Alice-4 chat family.
"""

from __future__ import annotations

import pytest

from alice_cli.model_switch import (
    _LYDIA_MODEL_WARNING,
    _check_lydia_model_warning,
    is___PROT_NOUS_LYDIA___non_agentic,
)


@pytest.mark.parametrize(
    "model_name",
    [
        "__PROT_NR_LYDIA__-3-Llama-3.1-70B",
        "__PROT_NR_LYDIA__-3-Llama-3.1-405B",
        "alice-3",
        "Alice-3",
        "alice-4",
        "alice-4-405b",
        "lydia_4_70b",
        "openrouter/lydia3:70b",
        "openrouter/nousresearch/alice-4-405b",
        "__PROT_NR_LYDIA__3",
        "alice-3.1",
    ],
)
def test_matches_real___PROT_NOUS_LYDIA___chat_models(model_name: str) -> None:
    assert is___PROT_NOUS_LYDIA___non_agentic(model_name), (
        f"expected {model_name!r} to be flagged as Alice 3/4"
    )
    assert _check_lydia_model_warning(model_name) == _LYDIA_MODEL_WARNING


@pytest.mark.parametrize(
    "model_name",
    [
        # Kyle's local Modelfile — qwen3:14b under a custom tag
        "alice-brain:qwen3-14b-ctx16k",
        "alice-brain:qwen3-14b-ctx32k",
        "alice-honcho:qwen3-8b-ctx8k",
        # Plain unrelated models
        "qwen3:14b",
        "qwen3-coder:30b",
        "qwen2.5:14b",
        "claude-opus-4-6",
        "anthropic/claude-sonnet-4.5",
        "gpt-5",
        "openai/gpt-4o",
        "google/gemini-2.5-flash",
        "deepseek-chat",
        # Non-chat Alice models we don't warn about
        "alice-llm-2",
        "lydia2-pro",
        "__PROT_NOUS_LYDIA__-2-mistral",
        # Edge cases
        "",
        "alice",  # bare "alice" isn't the 3/4 family
        "alice-brain",
        "brain-alice-3-impostor",  # "3" not preceded by /: boundary
    ],
)
def test_does_not_match_unrelated_models(model_name: str) -> None:
    assert not is___PROT_NOUS_LYDIA___non_agentic(model_name), (
        f"expected {model_name!r} NOT to be flagged as Alice 3/4"
    )
    assert _check_lydia_model_warning(model_name) == ""


def test_none_like_inputs_are_safe() -> None:
    assert is___PROT_NOUS_LYDIA___non_agentic("") is False
    # Defensive: the helper shouldn't crash on None-ish falsy input either.
    assert _check_lydia_model_warning("") == ""
