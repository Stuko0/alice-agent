"""Dynamic Provider Registry (DPR).

Custom providers are declared as small YAML files in
``~/.alice/providers.d/<id>.yaml`` — no Python, no code, no plugin install:

.. code-block:: yaml

    name: Together AI
    base_url: https://api.together.xyz/v1
    api_key_env: TOGETHER_API_KEY        # optional — env var holding the key
    api_mode: openai                     # openai (default) | anthropic
    models:                              # optional — pinned list
      - meta-llama/Llama-3.3-70B-Instruct-Turbo
      - deepseek-ai/DeepSeek-V3

``alice providers add/list/test/remove`` manage the registry; the desktop
Settings → Providers tab renders the same surface through ``/api/providers/*``.

The canonical runtime store stays ``config.providers`` (the keyed schema read
by ``alice_cli.config.get_compatible_custom_providers()`` and resolved by the
``custom:<name>`` credential pool). ``providers.d/`` is the source format: a
hand-writable YAML that ``add`` validates, normalises and merges into config.

Security: ``yaml.safe_load`` only (no arbitrary-object deserialisation), and
every spec passes through the same allowlisted normaliser the runtime uses —
unknown keys are dropped with a warning, never executed.
"""

from __future__ import annotations

import logging
import re
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

import yaml

_log = logging.getLogger(__name__)

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")


def providers_dir() -> Path:
    """``~/.alice/providers.d/`` — source files for custom providers."""
    from alice_constants import get_alice_home

    d = Path(get_alice_home()) / "providers.d"
    d.mkdir(parents=True, exist_ok=True)
    return d


def normalize_id(name: str) -> str:
    """Slugify a display name into a config key (``My Gateway!!`` → ``my-gateway``)."""
    slug = re.sub(r"[^a-z0-9_-]+", "-", name.strip().lower()).strip("-")
    return slug or "custom"


def validate_spec(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate + normalise a DPR spec dict.

    Raises ``ValueError`` for structurally invalid specs; returns the
    runtime-compatible entry (post ``_normalize_custom_provider_entry``).
    """
    if not isinstance(raw, dict):
        raise ValueError("provider spec must be a mapping")
    name = str(raw.get("name", "") or "").strip()
    if not name:
        raise ValueError("provider spec needs a 'name'")

    # Reuse the runtime normaliser — it is the single source of truth for
    # key allowlisting (drops unknown keys with a warning), camelCase
    # aliasing, and base_url validation.
    from alice_cli.config import _normalize_custom_provider_entry

    entry = _normalize_custom_provider_entry(dict(raw))
    if entry is None:
        # The runtime normaliser drops entries whose base_url is not a
        # scheme+host URL (or that have no URL key at all).
        raise ValueError("provider spec needs a valid 'base_url' (http(s) URL)")
    if not entry.get("name"):
        entry["name"] = name
    base_url = str(entry.get("base_url", "") or "").strip()
    if not base_url:
        raise ValueError("provider spec needs a valid 'base_url' (http(s) URL)")
    if not (base_url.startswith("http://") or base_url.startswith("https://")):
        raise ValueError(f"provider spec 'base_url' must be an http(s) URL, got: {base_url!r}")
    return entry


def _write_providers_yaml(provider_id: str, entry: dict[str, Any]) -> Path:
    """Mirror the normalized entry back to ``providers.d/<id>.yaml``."""
    path = providers_dir() / f"{provider_id}.yaml"
    path.write_text(yaml.safe_dump(entry, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return path


def add_custom_provider(spec: dict[str, Any]) -> dict[str, Any]:
    """Validate a spec and register it in ``config.providers``.

    Returns the stored entry. The provider id is the slugified ``name``.
    """
    entry = validate_spec(spec)
    provider_id = normalize_id(str(entry["name"]))

    from alice_cli.config import load_config, save_config

    cfg = load_config()
    providers = cfg.setdefault("providers", {})
    if not isinstance(providers, dict):
        providers = cfg["providers"] = {}
    providers[provider_id] = entry
    save_config(cfg)

    _write_providers_yaml(provider_id, entry)
    _log.info("provider_registry: registered custom provider %s (%s)", provider_id, entry.get("base_url"))
    return dict(entry)


def remove_custom_provider(provider_id: str) -> bool:
    """Remove a custom provider from config + ``providers.d/``. Returns False if unknown."""
    from alice_cli.config import load_config, save_config

    cfg = load_config()
    providers = cfg.get("providers")
    removed = False
    if isinstance(providers, dict) and provider_id in providers:
        del providers[provider_id]
        removed = True
        save_config(cfg)

    yaml_path = providers_dir() / f"{provider_id}.yaml"
    if yaml_path.exists():
        yaml_path.unlink()
        removed = True
    return removed


def list_custom_providers() -> list[dict[str, Any]]:
    """All registered custom providers (``config.providers`` + legacy list), deduped."""
    from alice_cli.config import get_compatible_custom_providers

    return get_compatible_custom_providers()


def find_provider(provider_id: str) -> dict[str, Any]:
    """Return the custom provider entry with this id, else raise KeyError."""
    from alice_cli.config import get_compatible_custom_providers

    for entry in get_compatible_custom_providers():
        key = str(entry.get("provider_key", "") or "").strip().lower()
        name = str(entry.get("name", "") or "").strip().lower()
        if key == provider_id or normalize_id(name) == provider_id:
            return entry
    raise KeyError(f"custom provider '{provider_id}' is not registered")


def test_provider(provider_id: str, timeout: float = 10.0) -> dict[str, Any]:
    """Probe a custom provider endpoint; return ``{ok, latency_ms, models?, error?}``.

    Hits ``GET {base_url}/models`` (OpenAI-compatible) — 2xx means the
    endpoint answers; the response body is parsed best-effort for a model
    list. Errors are captured, never raised.
    """
    entry = find_provider(provider_id)
    base_url = str(entry.get("base_url", "") or "").rstrip("/")
    api_key = str(entry.get("api_key", "") or "").strip()
    api_mode = str(entry.get("api_mode", "") or "").lower()

    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    if "anthropic" in api_mode:
        url = f"{base_url}/v1/messages" if not base_url.endswith("/v1") else f"{base_url}/messages"
    else:
        url = f"{base_url}/models" if not base_url.endswith("/models") else base_url

    started = time.monotonic()
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            latency_ms = int((time.monotonic() - started) * 1000)
            body = resp.read().decode("utf-8", "replace")
            try:
                data = yaml.safe_load(body) if body.startswith(("{", "[")) else {}
            except Exception:
                data = {}
            models = []
            if isinstance(data, dict):
                raw_models = data.get("data") or data.get("models") or []
                if isinstance(raw_models, list):
                    for m in raw_models:
                        if isinstance(m, dict) and m.get("id"):
                            models.append(str(m["id"]))
                        elif isinstance(m, str):
                            models.append(m)
            return {"ok": True, "latency_ms": latency_ms, "models": models[:50]}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "latency_ms": int((time.monotonic() - started) * 1000), "error": f"HTTP {exc.code}"}
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        return {"ok": False, "latency_ms": int((time.monotonic() - started) * 1000), "error": str(reason or exc)}
    except Exception as exc:  # socket.timeout, ssl errors, etc.
        return {"ok": False, "latency_ms": int((time.monotonic() - started) * 1000), "error": str(exc)}


def import_spec_file(path: Path) -> dict[str, Any]:
    """Read a DPR YAML file (``.yaml``/``.yml``/``.json``) and validate it.

    Raises ``ValueError`` on unreadable/invalid content — callers surface
    the message to the user unchanged.
    """
    p = Path(path)
    if not p.exists():
        raise ValueError(f"file not found: {p}")
    if p.suffix.lower() == ".json":
        import json

        with open(p, encoding="utf-8") as fh:
            raw = json.load(fh)
    else:
        with open(p, encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
    if raw is None:
        raise ValueError(f"empty provider file: {p}")
    return validate_spec(raw)
