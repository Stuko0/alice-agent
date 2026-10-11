"""fetch_api_models must not re-probe the network on every picker open.

The desktop model picker lists custom endpoints by probing their /models URL.
Without a cache each open paid one TLS round trip per endpoint (~1 s each).
These tests pin the contract: repeated calls for the same endpoint probe once,
an explicit refresh re-probes, and a different endpoint never reuses another's
result.
"""

import alice_cli.models as models


def _reset_cache():
    models._MODELS_ENDPOINT_CACHE.clear()


def test_repeated_calls_for_same_endpoint_probe_network_once(monkeypatch):
    _reset_cache()
    calls = []

    def fake_probe(api_key, base_url, timeout=5.0, api_mode=None):
        calls.append(base_url)
        return {"models": ["m1", "m2"]}

    monkeypatch.setattr(models, "probe_api_models", fake_probe)

    first = models.fetch_api_models("k", "https://ep.example/v1")
    second = models.fetch_api_models("k", "https://ep.example/v1")

    assert first == second == ["m1", "m2"]
    assert len(calls) == 1


def test_refresh_bypasses_cache_and_probes_again(monkeypatch):
    _reset_cache()
    calls = []

    def fake_probe(api_key, base_url, timeout=5.0, api_mode=None):
        calls.append(base_url)
        return {"models": ["m1"]}

    monkeypatch.setattr(models, "probe_api_models", fake_probe)

    models.fetch_api_models("k", "https://ep.example/v1")
    models.fetch_api_models("k", "https://ep.example/v1", refresh=True)

    assert len(calls) == 2


def test_different_endpoints_never_share_a_cached_result(monkeypatch):
    _reset_cache()

    def fake_probe(api_key, base_url, timeout=5.0, api_mode=None):
        return {"models": [f"from:{base_url}"]}

    monkeypatch.setattr(models, "probe_api_models", fake_probe)

    a = models.fetch_api_models("k", "https://a.example/v1")
    b = models.fetch_api_models("k", "https://b.example/v1")

    assert a != b


def test_failed_probe_is_not_cached(monkeypatch):
    _reset_cache()
    responses = iter([{"models": None}, {"models": ["ok"]}])
    calls = []

    def fake_probe(api_key, base_url, timeout=5.0, api_mode=None):
        calls.append(1)
        return next(responses)

    monkeypatch.setattr(models, "probe_api_models", fake_probe)

    assert models.fetch_api_models("k", "https://flaky.example/v1") is None
    # A failed probe is negatively cached for a short window, so a reopen does
    # not pay the timeout again; ``refresh`` clears it and retries immediately.
    assert models.fetch_api_models("k", "https://flaky.example/v1") is None
    assert len(calls) == 1
    assert models.fetch_api_models("k", "https://flaky.example/v1", refresh=True) == ["ok"]
    assert len(calls) == 2


def test_failed_probe_negative_cache_expires(monkeypatch):
    _reset_cache()
    clock = [1000.0]
    monkeypatch.setattr(models.time, "time", lambda: clock[0])
    calls = []

    def fake_probe(api_key, base_url, timeout=5.0, api_mode=None):
        calls.append(1)
        return {"models": None}

    monkeypatch.setattr(models, "probe_api_models", fake_probe)

    models.fetch_api_models("k", "https://down.example/v1")
    clock[0] += models._MODELS_ENDPOINT_NEGATIVE_TTL + 1
    models.fetch_api_models("k", "https://down.example/v1")
    assert len(calls) == 2
