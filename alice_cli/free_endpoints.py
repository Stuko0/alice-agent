"""Keyless, account-free OpenAI-compatible endpoints for the first run.

Alice's model config is already plain ``custom`` (base_url + api_key + model),
so "a provider you only need a URL for" is exactly that: a public endpoint and
nothing else. No Node, no npm, no local gateway, no download.

The onboarding's "Free — no account needed" row configures one of these so a
brand-new install can talk to a model before the user has any key.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Optional

_log = logging.getLogger(__name__)

# Endpoints that answer anonymously over plain HTTPS with the OpenAI wire
# format. Keep the list small and verified: each entry is a promise that a
# click works with no account, and a dead entry is worse than none.
FREE_ENDPOINTS: tuple[dict[str, str], ...] = (
    {
        "id": "pollinations",
        "label": "Pollinations",
        "description": "Public OpenAI-compatible endpoint (GPT-OSS 20B). No key, no account.",
        "base_url": "https://text.pollinations.ai/openai",
        "model": "openai-fast",
        # The endpoint ignores auth; the SDK requires a non-empty value.
        "api_key": "not-needed",
        "docs_url": "https://pollinations.ai",
    },
)

DEFAULT_ENDPOINT_ID = FREE_ENDPOINTS[0]["id"]


def list_endpoints() -> list[dict[str, str]]:
    """Public description of every endpoint (no keys, safe for the renderer)."""
    return [
        {k: v for k, v in entry.items() if k != "api_key"}
        for entry in FREE_ENDPOINTS
    ]


def get_endpoint(endpoint_id: Optional[str] = None) -> dict[str, str]:
    """Resolve one endpoint by id, defaulting to the preferred one."""
    wanted = (endpoint_id or DEFAULT_ENDPOINT_ID).strip().lower()

    for entry in FREE_ENDPOINTS:
        if entry["id"] == wanted:
            return entry

    raise ValueError(f"unknown free endpoint '{wanted}'")


def _describe_failure(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code == 429:
            return (
                "The free endpoint is rate-limiting anonymous requests right now. "
                "Try again in a minute, or pick a provider that uses your own key."
            )
        if exc.code in (401, 403):
            return (
                "The free endpoint refused anonymous access (HTTP "
                f"{exc.code}). It may have started requiring a key — pick another "
                "provider to continue."
            )
        return f"The free endpoint answered HTTP {exc.code}."

    if isinstance(exc, urllib.error.URLError):
        return (
            "Could not reach the free endpoint — check the connection, proxy or "
            f"firewall. ({exc.reason})"
        )

    return str(exc) or exc.__class__.__name__


def probe(endpoint: dict[str, str], timeout: float = 20.0) -> None:
    """Prove the endpoint answers with a model reply (raises RuntimeError).

    A real chat request, not a ``/models`` GET: several compatible gateways
    list models they will not actually serve to anonymous callers, and a probe
    that passes while the first message fails is worse than no probe at all.
    """
    body = json.dumps(
        {
            "model": endpoint["model"],
            "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
            "max_tokens": 16,
            "stream": False,
        }
    ).encode()

    request = urllib.request.Request(
        f"{endpoint['base_url'].rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {endpoint['api_key']}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise RuntimeError(_describe_failure(exc)) from exc
    except OSError as exc:
        raise RuntimeError(_describe_failure(exc)) from exc

    try:
        payload: Any = json.loads(raw)
        choices = payload["choices"]
        if not choices:
            raise KeyError("choices")
    except Exception as exc:  # noqa: BLE001 — any shape surprise is a failure
        raise RuntimeError(
            f"The free endpoint replied with something that is not an OpenAI chat response: {raw[:200]}"
        ) from exc


def apply_config(endpoint: dict[str, str]) -> dict[str, str]:
    """Point the model config at this endpoint and return what was written."""
    from alice_cli.config import load_config, save_config

    cfg = load_config()
    model = cfg.setdefault("model", {})
    if not isinstance(model, dict):
        model = cfg["model"] = {"default": model} if model else {}

    model["provider"] = "custom"
    model["base_url"] = endpoint["base_url"]
    model["api_key"] = endpoint["api_key"]
    model["default"] = endpoint["model"]
    save_config(cfg)

    return {
        "base_url": endpoint["base_url"],
        "model": endpoint["model"],
        "provider": entry_provider(),
    }


def entry_provider() -> str:
    """The config provider id the endpoint lands on (stock ``custom``)."""
    return "custom"
