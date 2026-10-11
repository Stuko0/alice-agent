"""Tests for providers config entry validation and normalization.

Covers Issue #9332: camelCase keys silently ignored, non-URL strings
accepted as base_url, and unknown keys go unreported.
"""

import logging


from alice_cli.config import _normalize_custom_provider_entry


class TestNormalizeCustomProviderEntry:
    """Tests for _normalize_custom_provider_entry validation."""

    def test_valid_entry_snake_case(self):
        """Standard snake_case entry should normalize correctly."""
        entry = {
            "base_url": "https://api.example.com/v1",
            "api_key": "sk-test-key",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="myhost")
        assert result is not None
        assert result["name"] == "myhost"
        assert result["base_url"] == "https://api.example.com/v1"
        assert result["api_key"] == "sk-test-key"

    def test_camel_case_api_key_mapped(self):
        """camelCase apiKey should be auto-mapped to api_key."""
        entry = {
            "base_url": "https://api.example.com/v1",
            "apiKey": "sk-test-key",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="myhost")
        assert result is not None
        assert result["api_key"] == "sk-test-key"

    def test_camel_case_base_url_mapped(self):
        """camelCase baseUrl should be auto-mapped to base_url."""
        entry = {
            "baseUrl": "https://api.example.com/v1",
            "api_key": "sk-test-key",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="myhost")
        assert result is not None
        assert result["base_url"] == "https://api.example.com/v1"

    def test_non_url_api_field_rejected(self):
        """Non-URL string in 'api' field should be skipped with a warning."""
        entry = {
            "api": "openai-reverse-proxy",
            "api_key": "sk-test-key",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="nvidia")
        # Should return None because no valid URL was found
        assert result is None

    def test_valid_url_in_api_field_accepted(self):
        """Valid URL in 'api' field should still be accepted."""
        entry = {
            "api": "https://integrate.api.nvidia.com/v1",
            "api_key": "sk-test-key",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="nvidia")
        assert result is not None
        assert result["base_url"] == "https://integrate.api.nvidia.com/v1"

    def test_base_url_preferred_over_api(self):
        """base_url should be checked before api field."""
        entry = {
            "base_url": "https://correct.example.com/v1",
            "api": "https://wrong.example.com/v1",
            "api_key": "sk-test-key",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="test")
        assert result is not None
        assert result["base_url"] == "https://correct.example.com/v1"

    def test_unknown_keys_logged(self, caplog):
        """Unknown config keys should produce a warning."""
        entry = {
            "base_url": "https://api.example.com/v1",
            "api_key": "***",
            "unknownField": "value",
            "anotherBad": 42,
        }
        with caplog.at_level(logging.WARNING):
            result = _normalize_custom_provider_entry(entry, provider_key="test")
        assert result is not None
        assert any("unknown config keys" in r.message.lower() for r in caplog.records)

    def test_timeout_keys_not_flagged_unknown(self, caplog):
        """request_timeout_seconds and stale_timeout_seconds should not produce warnings."""
        entry = {
            "base_url": "https://api.example.com/v1",
            "api_key": "***",
            "request_timeout_seconds": 300,
            "stale_timeout_seconds": 900,
        }
        with caplog.at_level(logging.WARNING):
            result = _normalize_custom_provider_entry(entry, provider_key="test")
        assert result is not None
        assert not any("unknown config keys" in r.message.lower() for r in caplog.records)

    def test_camel_case_warning_logged(self, caplog):
        """camelCase alias mapping should produce a warning."""
        entry = {
            "baseUrl": "https://api.example.com/v1",
            "apiKey": "sk-test-key",
        }
        with caplog.at_level(logging.WARNING):
            result = _normalize_custom_provider_entry(entry, provider_key="test")
        assert result is not None
        camel_warnings = [r for r in caplog.records if "camelcase" in r.message.lower() or "auto-mapped" in r.message.lower()]
        assert len(camel_warnings) >= 1

    def test_snake_case_takes_precedence_over_camel(self):
        """If both snake_case and camelCase exist, snake_case wins."""
        entry = {
            "api_key": "snake-key",
            "apiKey": "camel-key",
            "base_url": "https://api.example.com/v1",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="test")
        assert result is not None
        assert result["api_key"] == "snake-key"

    def test_non_dict_returns_none(self):
        """Non-dict entry should return None."""
        assert _normalize_custom_provider_entry("not-a-dict") is None
        assert _normalize_custom_provider_entry(42) is None
        assert _normalize_custom_provider_entry(None) is None

    def test_no_url_returns_none(self):
        """Entry with no valid URL in any field should return None."""
        entry = {
            "api_key": "sk-test-key",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="test")
        assert result is None

    def test_no_name_returns_none(self):
        """Entry with no name and no provider_key should return None."""
        entry = {
            "base_url": "https://api.example.com/v1",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="")
        assert result is None

    def test_models_list_converted_to_dict(self):
        """List-format models should be preserved as an empty-value dict so
        /model picks them up instead of showing the provider with (0) models."""
        entry = {
            "name": "tencent-coding-plan",
            "base_url": "https://api.lkeap.cloud.tencent.com/coding/v3",
            "models": ["glm-5", "kimi-k2.5", "minimax-m2.5"],
        }
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["models"] == {"glm-5": {}, "kimi-k2.5": {}, "minimax-m2.5": {}}

    def test_models_dict_preserved(self):
        """Dict-format models should pass through unchanged."""
        entry = {
            "name": "acme",
            "base_url": "https://api.example.com/v1",
            "models": {"gpt-foo": {"context_length": 32000}},
        }
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["models"] == {"gpt-foo": {"context_length": 32000}}

    def test_models_list_filters_empty_and_non_string(self):
        """List entries that are empty strings or non-strings are skipped."""
        entry = {
            "name": "acme",
            "base_url": "https://api.example.com/v1",
            "models": ["valid", "", None, 42, "  ", "also-valid"],
        }
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["models"] == {"valid": {}, "also-valid": {}}

    def test_models_empty_list_omitted(self):
        """Empty list (falsy) should not produce a models key."""
        entry = {
            "name": "acme",
            "base_url": "https://api.example.com/v1",
            "models": [],
        }
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert "models" not in result

    def test_env_var_placeholder_in_base_url_not_rejected(self):
        """A base_url that is an un-expanded ${ENV_VAR} placeholder must not be
        rejected as an invalid URL — it is expanded at runtime, so a caller
        reaching this normalizer with raw config would otherwise see the
        provider silently dropped. Regression test for #14457."""
        entry = {
            "name": "PROVIDER_A",
            "base_url": "${PROVIDER_A_BASE_URL}",
            "key_env": "PROVIDER_A_API_KEY",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="PROVIDER_A")
        assert result is not None
        assert result["base_url"] == "${PROVIDER_A_BASE_URL}"

    def test_multiple_env_vars_in_base_url(self):
        """base_url with multiple ${VAR} placeholders is accepted verbatim."""
        entry = {
            "name": "multi-var-provider",
            "base_url": "${SCHEME}://${HOST}:${PORT}/v1",
        }
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["base_url"] == "${SCHEME}://${HOST}:${PORT}/v1"

    def test_bare_brace_region_placeholder_accepted(self):
        """A bare {region}-style template token (not an env-ref) is also
        accepted without validation, supporting region-substitution URLs."""
        entry = {
            "name": "regional",
            "base_url": "https://{region}.api.example.com/v1",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="regional")
        assert result is not None
        assert result["base_url"] == "https://{region}.api.example.com/v1"

    def test_invalid_url_without_placeholder_still_rejected(self):
        """A malformed URL with no scheme/host AND no placeholder token is
        still rejected — the placeholder bypass must not weaken validation of
        ordinary literal URLs."""
        entry = {
            "name": "bad",
            "base_url": "not-a-url",
        }
        result = _normalize_custom_provider_entry(entry, provider_key="bad")
        assert result is None


class TestEndpointPathStrippedFromBaseUrl:
    """A pasted chat endpoint is normalised down to a real base URL.

    Contract: ``base_url`` must never include the request path, because every
    consumer (``/models`` discovery, the OpenAI SDK, the credential pool)
    appends its own path. When it does, discovery probes
    ``<endpoint>/models`` → 404, the provider row carries 0 models, and the
    desktop picker (which filters out 0-model rows) hides it entirely.
    """

    def test_chat_completions_suffix_stripped(self):
        entry = {"name": "TokenHarbor", "base_url": "https://tokenharbor.ai/v1/chat/completions"}
        result = _normalize_custom_provider_entry(entry, provider_key="tokenharbor")
        assert result is not None
        assert result["base_url"] == "https://tokenharbor.ai/v1"

    def test_legacy_completions_suffix_stripped(self):
        entry = {"name": "legacy", "base_url": "https://api.example.com/v1/completions"}
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["base_url"] == "https://api.example.com/v1"

    def test_trailing_whitespace_and_suffix_stripped(self):
        entry = {"name": "ws", "base_url": "  https://api.example.com/v1/chat/completions  "}
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["base_url"] == "https://api.example.com/v1"

    def test_root_level_endpoint_keeps_host(self):
        """``https://host/chat/completions`` (no /v1) collapses to the host."""
        entry = {"name": "root", "base_url": "https://host.example.com/chat/completions"}
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["base_url"] == "https://host.example.com"

    def test_plain_base_url_left_untouched(self):
        """Regression guard: an already-correct base_url is not altered."""
        entry = {"name": "ok", "base_url": "https://api.example.com/v1"}
        result = _normalize_custom_provider_entry(entry)
        assert result is not None
        assert result["base_url"] == "https://api.example.com/v1"

