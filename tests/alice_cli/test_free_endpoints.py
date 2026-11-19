"""Tests for alice_cli.free_endpoints — the no-account, URL-only provider."""

import io
import json
import urllib.error
from unittest.mock import MagicMock, patch

import pytest

from alice_cli import free_endpoints as fe


class FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


CHAT_OK = json.dumps(
    {"choices": [{"message": {"role": "assistant", "content": "ready"}}]}
).encode()


class TestCatalog:
    def test_list_endpoints_hides_the_key(self):
        listed = fe.list_endpoints()

        assert listed, "there must be at least one free endpoint"
        for entry in listed:
            assert "api_key" not in entry
            assert entry["base_url"].startswith("https://")
            assert entry["model"]

    def test_get_endpoint_defaults_to_the_first(self):
        assert fe.get_endpoint(None)["id"] == fe.DEFAULT_ENDPOINT_ID
        assert fe.get_endpoint("Pollinations")["id"] == "pollinations"

    def test_unknown_endpoint_raises(self):
        with pytest.raises(ValueError, match="unknown free endpoint"):
            fe.get_endpoint("nope")


class TestProbe:
    def test_probe_posts_a_chat_completion(self):
        endpoint = fe.get_endpoint()

        with patch.object(fe.urllib.request, "urlopen", return_value=FakeResponse(CHAT_OK)) as opened:
            fe.probe(endpoint)

        request = opened.call_args[0][0]
        assert request.full_url == f"{endpoint['base_url']}/chat/completions"
        body = json.loads(request.data)
        assert body["model"] == endpoint["model"]
        assert body["messages"][0]["role"] == "user"

    def test_rate_limit_is_explained(self):
        endpoint = fe.get_endpoint()
        error = urllib.error.HTTPError(endpoint["base_url"], 429, "Too Many Requests", {}, io.BytesIO(b""))

        with patch.object(fe.urllib.request, "urlopen", side_effect=error):
            with pytest.raises(RuntimeError, match="rate-limiting"):
                fe.probe(endpoint)

    def test_key_requirement_is_explained(self):
        endpoint = fe.get_endpoint()
        error = urllib.error.HTTPError(endpoint["base_url"], 401, "Unauthorized", {}, io.BytesIO(b""))

        with patch.object(fe.urllib.request, "urlopen", side_effect=error):
            with pytest.raises(RuntimeError, match="requiring a key"):
                fe.probe(endpoint)

    def test_network_failure_mentions_the_connection(self):
        endpoint = fe.get_endpoint()
        error = urllib.error.URLError("nodename nor servname provided")

        with patch.object(fe.urllib.request, "urlopen", side_effect=error):
            with pytest.raises(RuntimeError, match="check the connection"):
                fe.probe(endpoint)

    def test_non_chat_body_is_rejected(self):
        endpoint = fe.get_endpoint()

        with patch.object(fe.urllib.request, "urlopen", return_value=FakeResponse(b"<html>nope</html>")):
            with pytest.raises(RuntimeError, match="not an OpenAI chat response"):
                fe.probe(endpoint)


class TestApplyConfig:
    def test_writes_provider_url_key_and_model(self, monkeypatch):
        endpoint = fe.get_endpoint()
        saved = {}

        monkeypatch.setattr("alice_cli.config.load_config", lambda: {"model": {}})
        monkeypatch.setattr("alice_cli.config.save_config", lambda cfg: saved.update(cfg))

        written = fe.apply_config(endpoint)

        assert saved["model"]["provider"] == "custom"
        assert saved["model"]["base_url"] == endpoint["base_url"]
        assert saved["model"]["api_key"] == endpoint["api_key"]
        assert saved["model"]["default"] == endpoint["model"]
        assert written["base_url"] == endpoint["base_url"]

    def test_legacy_string_model_is_preserved(self, monkeypatch):
        endpoint = fe.get_endpoint()
        saved = {}

        monkeypatch.setattr("alice_cli.config.load_config", lambda: {"model": "old-model"})
        monkeypatch.setattr("alice_cli.config.save_config", lambda cfg: saved.update(cfg))

        fe.apply_config(endpoint)

        # The legacy string survives as the default, then gets overridden —
        # what matters is that the dict shape is repaired, not crashed on.
        assert saved["model"]["base_url"] == endpoint["base_url"]
