"""Provider-wiring E2E, run against the *packaged* runtime on Windows.

Three scenarios, in the order a real install hits them:

A. ``custom`` endpoint + API key  -> the key must leave as
   ``Authorization: Bearer`` and the agent must get a reply.
B. same endpoint with ``api_mode: anthropic_messages`` -> the key leaves as
   ``x-api-key`` instead (the reason an OpenAI-compatible gateway answers
   "Missing Authentication header" even though "auth=set").
C. the keyless free endpoint (``free_endpoints``) -> a real reply over the
   network, retried a couple of times because the anonymous tier rate-limits.

A failure in A fails the run: that is the path every API-key provider uses.
B and C report and continue — B documents a configuration trap, and C depends
on a third-party endpoint being up.

Usage:
    python scripts/provider_e2e.py            # run the scenarios
    python scripts/provider_e2e.py --mock      # run the fixture server only
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

MOCK_PORT = 9423
MOCK_MODEL = "mock/model-ok"


# ── fixture server ─────────────────────────────────────────────────────────


def serve_mock() -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    def sse(obj: dict) -> bytes:
        return f"data: {json.dumps(obj)}\n\n".encode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _json(self, code: int, payload: dict) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self) -> None:  # noqa: N802 — http.server API
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")

            record = {
                "path": self.path,
                "authorization": bool(self.headers.get("authorization")),
                "x_api_key": bool(self.headers.get("x-api-key")),
                "model": body.get("model"),
                "stream": bool(body.get("stream")),
            }
            with open(os.environ["MOCK_LOG"], "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")

            if not record["authorization"] and not record["x_api_key"]:
                self._json(401, {"error": {"message": "Missing Authentication header"}})
                return

            if "/chat/completions" not in self.path:
                self._json(404, {"error": {"message": "not found"}})
                return

            model = body.get("model") or "mock"

            if "stall" in str(model).lower() and body.get("stream"):
                # Keep-alive frames only: a valid SSE stream that never carries
                # model output. This is what a stalled gateway/proxy looks like,
                # and what used to hang the UI for minutes with no error.
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                try:
                    for _ in range(120):
                        self.wfile.write(
                            sse({"id": "x", "object": "chat.completion.chunk", "created": 0,
                                 "model": model, "choices": []})
                        )
                        self.wfile.flush()
                        time.sleep(0.25)
                except OSError:
                    pass
                self.close_connection = True
                return

            if body.get("stream"):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                chunk = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": model}
                self.wfile.write(sse({**chunk, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}))
                self.wfile.write(sse({**chunk, "choices": [{"index": 0, "delta": {"content": "pong"}, "finish_reason": None}]}))
                self.wfile.write(
                    sse(
                        {
                            **chunk,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                        }
                    )
                )
                self.wfile.write(b"data: [DONE]\n\n")
                self.close_connection = True
                return

            self._json(
                200,
                {
                    "id": "x",
                    "object": "chat.completion",
                    "created": 0,
                    "model": model,
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            )

        def log_message(self, *_args) -> None:
            pass

    ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Handler).serve_forever()


# ── scenario helpers ───────────────────────────────────────────────────────


def write_config(home: Path, lines: str) -> None:
    (home / "config.yaml").write_text(lines, encoding="utf-8")


def read_mock_log(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def run_agent_once(model: str, prompt: str) -> str:
    from alice_cli.runtime_provider import resolve_runtime_provider
    from run_agent import AIAgent

    runtime = resolve_runtime_provider()
    agent = AIAgent(
        base_url=runtime["base_url"],
        api_key=runtime["api_key"],
        provider=runtime["provider"],
        model=model,
        quiet_mode=True,
        skip_memory=True,
        skip_context_files=True,
        enabled_toolsets=[],
        max_iterations=1,
    )
    return agent.chat(prompt)


def wait_for_mock(timeout: float = 15.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{MOCK_PORT}/health", timeout=1)
        except urllib.error.HTTPError:
            return
        except OSError:
            time.sleep(0.3)
    raise RuntimeError("fixture server did not start")


def scenario_a(home: Path, mock_log: Path) -> bool:
    print("\n=== A. custom endpoint + API key (chat_completions) ===")
    write_config(
        home,
        "model:\n"
        "  provider: custom\n"
        f"  default: {MOCK_MODEL}\n"
        f"  base_url: http://127.0.0.1:{MOCK_PORT}/v1\n"
        "  api_key: sk-provider-e2e\n",
    )

    reply = run_agent_once(MOCK_MODEL, "Reply with the single word: ready")
    print(f"reply: {reply!r}")

    requests = read_mock_log(mock_log)
    chat = [r for r in requests if "/chat/completions" in r["path"]]

    ok = reply.strip() == "pong" and bool(chat)
    bearer_only = ok and all(r["authorization"] and not r["x_api_key"] for r in chat)
    print(f"requests: {len(chat)} | Authorization present: {bearer_only}")

    if not ok:
        print("FAIL: the agent did not complete a turn against the configured endpoint")
        return False
    if not bearer_only:
        print("FAIL: the key did not leave as 'Authorization: Bearer'")
        return False

    print("PASS")
    return True


def scenario_b(home: Path, mock_log: Path) -> None:
    print("\n=== B. same endpoint with api_mode=anthropic_messages ===")
    write_config(
        home,
        "model:\n"
        "  provider: custom\n"
        f"  default: {MOCK_MODEL}\n"
        f"  base_url: http://127.0.0.1:{MOCK_PORT}/v1\n"
        "  api_key: sk-provider-e2e\n"
        "  api_mode: anthropic_messages\n",
    )

    before = len(read_mock_log(mock_log))
    try:
        run_agent_once(MOCK_MODEL, "ping")
    except Exception as exc:  # noqa: BLE001 — informational scenario
        print(f"agent error (expected for an OpenAI-only gateway): {exc}")

    requests = read_mock_log(mock_log)[before:]
    used_header = {("x-api-key" if r["x_api_key"] else "authorization") for r in requests if r}

    print(f"headers seen: {sorted(used_header) or 'none'}")
    if used_header == {"x-api-key"}:
        print(
            "note: this endpoint would answer 401 'Missing Authentication header' — "
            "an OpenAI-compatible gateway needs api_mode: chat_completions"
        )
    elif used_header == {"authorization"}:
        print("note: api_mode=anthropic_messages still sent Authorization — unexpected")


def scenario_c(home: Path) -> None:
    print("\n=== C. free endpoint (keyless, public) ===")
    from alice_cli import free_endpoints

    endpoint = free_endpoints.get_endpoint()
    print(f"endpoint: {endpoint['base_url']} model={endpoint['model']}")

    free_endpoints.apply_config(endpoint)

    for attempt in range(1, 4):
        try:
            reply = run_agent_once(endpoint["model"], "Reply with the single word: ready")
        except Exception as exc:  # noqa: BLE001 — network/ratelimit dependent
            print(f"attempt {attempt}: error: {exc}")
            time.sleep(5)
            continue

        text = reply.strip()
        print(f"attempt {attempt}: reply={text[:120]!r}")
        if text and "api call failed" not in text.lower():
            print("PASS")
            return
        time.sleep(5)

    print("SKIP: the public endpoint did not answer (rate limit or blocked network)")


def scenario_d(home: Path) -> bool:
    """OpenCode Go with a real (free-tier) model — the sibling of scenario A.

    Unlike A/C this needs a credential, so it only runs when the harness is
    given one (``OPENCODE_GO_API_KEY``); CI supplies it as a secret. A failure
    here is fatal: it is the "does Alice talk to a real model" proof.
    """
    print("\n=== D. OpenCode Go (real model, free tier) ===")

    key = (os.environ.get("OPENCODE_GO_API_KEY") or "").strip()
    if not key:
        print("SKIP: OPENCODE_GO_API_KEY is not set")
        return True

    model = (os.environ.get("ALICE_E2E_OPENCODE_MODEL") or "hy4-flash-free").strip()
    write_config(home, f"model:\n  provider: opencode-go\n  default: {model}\n")

    reply = run_agent_once(model, "Reply with exactly: WINDOWS-OK")
    text = (reply or "").strip()
    print(f"model={model} reply={text[:120]!r}")

    if not text or "api call failed" in text.lower() or "error:" in text.lower()[:12]:
        print("FAIL: the OpenCode Go model did not answer")
        return False

    print("PASS")
    return True


def scenario_e(home: Path) -> bool:
    """A provider that keeps the socket warm but never sends output.

    Before the fix, keep-alive frames reset the stale timer and the UI waited
    indefinitely (reported as an 8-minute silent hang on Windows). The call
    must now fail within the configured window with a readable error.
    """
    print("\n=== E. stalled stream (keep-alives, no output) ===")

    write_config(
        home,
        "model:\n"
        "  provider: custom\n"
        "  default: mock/stall\n"
        f"  base_url: http://127.0.0.1:{MOCK_PORT}/v1\n"
        "  api_key: sk-provider-e2e\n",
    )

    os.environ["ALICE_STREAM_STALE_TIMEOUT"] = "3"
    started = time.time()
    try:
        reply = run_agent_once("mock/stall", "ping")
    finally:
        os.environ.pop("ALICE_STREAM_STALE_TIMEOUT", None)

    elapsed = time.time() - started
    text = (reply or "").strip()
    print(f"elapsed={elapsed:.1f}s reply={text[:100]!r}")

    # Must return (not hang) and say it failed.
    if elapsed > 120:
        print("FAIL: the stalled stream was not detected in time")
        return False
    if "failed" not in text.lower() and "error" not in text.lower():
        print("FAIL: the stall did not surface as an error")
        return False

    print("PASS")
    return True


# ── entry point ────────────────────────────────────────────────────────────


def main() -> int:
    if "--mock" in sys.argv:
        serve_mock()
        return 0

    home = Path(os.environ["E2E_ALICE_HOME"]).resolve()
    home.mkdir(parents=True, exist_ok=True)
    os.environ["ALICE_HOME"] = str(home)

    mock_log = home / "mock-requests.jsonl"
    mock_log.unlink(missing_ok=True)
    os.environ["MOCK_LOG"] = str(mock_log)

    server = subprocess.Popen([sys.executable, str(Path(__file__)), "--mock"])
    try:
        wait_for_mock()
        passed = scenario_a(home, mock_log)
        scenario_b(home, mock_log)
        scenario_c(home)
        real_model = scenario_d(home)
        stall_detected = scenario_e(home)
    finally:
        server.terminate()

    print("\n=== summary ===")
    print(f"custom+key: {'PASS' if passed else 'FAIL'}")
    print(f"opencode-go real model: {'PASS' if real_model else 'FAIL'}")
    print(f"stall detection: {'PASS' if stall_detected else 'FAIL'}")
    return 0 if passed and real_model and stall_detected else 1


if __name__ == "__main__":
    raise SystemExit(main())
