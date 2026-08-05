"""Tests for the Dynamic Provider Registry (DPR).

`providers.d/<id>.yaml` is the hand-writable source format; `config.providers`
is the canonical runtime store. Tests exercise validation, round-trips and
the test-provider connectivity probe with a mocked HTTP layer."""

from pathlib import Path

import pytest

from alice_cli import provider_registry as pr


@pytest.fixture
def alice_home(tmp_path, monkeypatch):
    """Isolated ALICE_HOME for every test (config.yaml + providers.d live there)."""
    import alice_constants

    monkeypatch.setattr(alice_constants, "get_alice_home", lambda: tmp_path)
    (tmp_path / "providers.d").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _spec(**overrides) -> dict:
    spec = {
        "name": "My Gateway",
        "base_url": "https://gateway.example.com/v1",
        "api_key_env": "MY_GATEWAY_KEY",
        "models": ["model-a", "model-b"],
    }
    spec.update(overrides)
    return spec


class TestValidateSpec:
    def test_accepts_valid_spec(self, alice_home):
        out = pr.validate_spec(_spec())
        assert out["name"] == "My Gateway"
        assert out["base_url"] == "https://gateway.example.com/v1"

    def test_rejects_missing_name(self, alice_home):
        with pytest.raises(ValueError, match="name"):
            pr.validate_spec(_spec(name=""))

    def test_rejects_bad_base_url(self, alice_home):
        with pytest.raises(ValueError, match="URL"):
            pr.validate_spec(_spec(base_url="not a url"))

    def test_rejects_unknown_keys_are_dropped_not_crash(self, alice_home):
        # _normalize_custom_provider_entry warns + drops unknown keys; the
        # spec stays usable (does NOT eval arbitrary code).
        out = pr.validate_spec(_spec(evil="__import__('os').system('id')"))
        assert "evil" not in out
        assert out["name"] == "My Gateway"


class TestAddRemove:
    def test_add_writes_config_and_providers_dir(self, alice_home):
        entry = pr.add_custom_provider(_spec())
        assert entry["name"] == "My Gateway"

        # config.providers updated
        from alice_cli.config import load_config

        cfg = load_config()
        providers = cfg.get("providers") or {}
        assert "my-gateway" in providers
        assert providers["my-gateway"]["base_url"] == "https://gateway.example.com/v1"

        # providers.d/<id>.yaml materialised (id = normalized name)
        yaml_path = alice_home / "providers.d" / "my-gateway.yaml"
        assert yaml_path.exists()

    def test_add_overwrites_same_id(self, alice_home):
        pr.add_custom_provider(_spec(base_url="https://one.example.com/v1"))
        pr.add_custom_provider(_spec(base_url="https://two.example.com/v1"))
        from alice_cli.config import load_config

        providers = (load_config().get("providers") or {})
        assert providers["my-gateway"]["base_url"] == "https://two.example.com/v1"

    def test_remove_deletes_config_and_yaml(self, alice_home):
        pr.add_custom_provider(_spec())
        assert pr.remove_custom_provider("my-gateway") is True

        from alice_cli.config import load_config

        assert "my-gateway" not in (load_config().get("providers") or {})
        assert not (alice_home / "providers.d" / "my-gateway.yaml").exists()

    def test_remove_missing_returns_false(self, alice_home):
        assert pr.remove_custom_provider("nope") is False

    def test_id_normalization(self, alice_home):
        pr.add_custom_provider(_spec(name="Together AI!!"))
        from alice_cli.config import load_config

        assert "together-ai" in (load_config().get("providers") or {})


class TestList:
    def test_list_includes_registered_custom(self, alice_home):
        pr.add_custom_provider(_spec())
        names = [p.get("name") for p in pr.list_custom_providers()]
        assert "My Gateway" in names

    def test_list_empty_when_none(self, alice_home):
        assert pr.list_custom_providers() == []


class TestCatalogIntegration:
    def test_custom_provider_appears_in_unified_catalog(self, alice_home):
        pr.add_custom_provider(_spec(name="Together AI"))
        from alice_cli.provider_catalog import provider_catalog

        slugs = [d.slug for d in provider_catalog()]
        assert "custom:together-ai" in slugs
        desc = next(d for d in provider_catalog() if d.slug == "custom:together-ai")
        assert desc.tab == "keys"
        assert desc.label == "Together AI (custom)"

    def test_removed_provider_leaves_catalog(self, alice_home):
        pr.add_custom_provider(_spec(name="Together AI"))
        pr.remove_custom_provider("together-ai")
        from alice_cli.provider_catalog import provider_catalog

        assert not any(d.slug == "custom:together-ai" for d in provider_catalog())


class TestProbe:
    def test_probe_ok_on_200(self, alice_home, monkeypatch):
        import urllib.request

        class FakeResp:
            status = 200

            def read(self):
                return b'{"data":[{"id":"m1"}]}'

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(url, timeout=None):
            target = getattr(url, "full_url", str(url))
            assert "gateway.example.com/v1/models" in target
            return FakeResp()

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        pr.add_custom_provider(_spec())
        result = pr.test_provider("my-gateway")
        assert result["ok"] is True
        assert "m1" in result["models"]

    def test_probe_fails_on_404(self, alice_home, monkeypatch):
        import urllib.error
        import urllib.request

        def fake_urlopen(url, timeout=None):
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

        monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
        pr.add_custom_provider(_spec())
        result = pr.test_provider("my-gateway")
        assert result["ok"] is False
        assert "404" in result["error"]

    def test_probe_unknown_provider(self, alice_home):
        with pytest.raises(KeyError):
            pr.test_provider("does-not-exist")
