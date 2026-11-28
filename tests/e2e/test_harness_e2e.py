"""End-to-end harness verification.

Runs the real ``alice -z`` process against a local OpenAI-compatible server and
checks observable behaviour at the process boundary:

* plan mode reaches the model as a read-only tool schema,
* a hallucinated ``write_file`` call is rejected without touching the disk,
* a real ``read_file`` call works and its result is sent back,
* the per-turn telemetry line lands in the agent log,
* the CLI exits 0 with the model's final text.

No network, no credentials: the server is a stdlib HTTP server on loopback.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

FINAL_TEXT = "PLAN OK: read the file, would patch target.py next."


USAGE = {"prompt_tokens": 1_000, "completion_tokens": 40, "total_tokens": 1_040}


def _write_sse(wfile, chunks):
    """Write an OpenAI-style SSE stream from pre-built delta dicts.

    Usage rides on the final chunk (the ``include_usage`` shape): the client
    only records token counts when a chunk carries ``usage``.
    """
    for i, (delta, finish) in enumerate(chunks):
        payload = {
            "id": "chatcmpl-fake",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "fake/model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        if i == len(chunks) - 1 or finish:
            payload["usage"] = USAGE
        wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
    wfile.write(b"data: [DONE]\n\n")
    wfile.flush()


class _FakeModel:
    """Scripted OpenAI-compatible endpoint.

    The script is derived from the conversation state, not from a call
    counter, so auxiliary requests (session titler, etc.) cannot shift it:

    * agent call with no tool results yet -> write_file (must be rejected)
    * one tool result (the rejection)     -> read_file (allowed)
    * two or more tool results            -> final assistant text
    """

    def __init__(self):
        self.requests: list[dict] = []

    def script_for(self, body: dict):
        if not body.get("tools"):
            # Auxiliary call (title generation, …): plain text is enough.
            return ({"role": "assistant", "content": "Fake title"}, "stop")

        messages = body.get("messages") or []
        tool_results = [m for m in messages if m.get("role") == "tool"]

        if not tool_results:
            return (
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_write",
                            "type": "function",
                            "function": {
                                "name": "write_file",
                                "arguments": json.dumps(
                                    {"path": "pwned.txt", "content": "x"}
                                ),
                            },
                        }
                    ],
                },
                "tool_calls",
            )
        if len(tool_results) == 1:
            return (
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_read",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": json.dumps({"path": "target.py"}),
                            },
                        }
                    ],
                },
                "tool_calls",
            )
        return ({"role": "assistant", "content": FINAL_TEXT}, "stop")


def _make_handler(model: _FakeModel):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # silence
            pass

        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}

            if not self.path.rstrip("/").endswith("/chat/completions"):
                self.send_error(404)
                return

            model.requests.append(body)
            message, finish = model.script_for(body)

            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                if finish == "tool_calls":
                    announced = []
                    for tc in message["tool_calls"]:
                        announced.append(
                            {
                                "index": tc.get("index", 0),
                                "id": tc.get("id"),
                                "type": "function",
                                "function": {
                                    "name": tc["function"]["name"],
                                    "arguments": "",
                                },
                            }
                        )
                    streamed = []
                    for tc in message["tool_calls"]:
                        streamed.append(
                            {
                                "index": tc.get("index", 0),
                                "function": {
                                    "arguments": tc["function"]["arguments"]
                                },
                            }
                        )
                    chunks = [
                        ({"tool_calls": announced}, None),
                        ({"tool_calls": streamed}, None),
                    ]
                    _write_sse(self.wfile, chunks + [({}, "tool_calls")])
                else:
                    _write_sse(
                        self.wfile,
                        [({"content": message["content"]}, None), ({}, "stop")],
                    )
                return

            resp = {
                "id": "chatcmpl-fake",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "fake/model",
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {
                    "prompt_tokens": 1_000,
                    "completion_tokens": 40,
                    "total_tokens": 1_040,
                },
            }
            data = json.dumps(resp).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _tool_names(request: dict) -> set[str]:
    return {
        t.get("function", {}).get("name")
        for t in (request.get("tools") or [])
        if isinstance(t, dict)
    }


@pytest.fixture
def harness(tmp_path):
    model = _FakeModel()
    port = _free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), _make_handler(model))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield model, port, tmp_path
    finally:
        server.shutdown()
        server.server_close()


def test_plan_mode_end_to_end(harness):
    model, port, tmp_path = harness

    alice_home = tmp_path / ".alice"
    workdir = tmp_path / "work"
    (alice_home).mkdir(parents=True)
    workdir.mkdir()
    (workdir / "target.py").write_text("VALUE = 42\n", encoding="utf-8")
    (alice_home / "config.yaml").write_text(
        "model:\n"
        "  provider: custom\n"
        "  default: fake/model\n"
        f"  base_url: http://127.0.0.1:{port}/v1\n"
        "  api_key: test-key\n"
        "  context_length: 131072\n"
        "compression:\n"
        "  enabled: false\n"
        "logging:\n"
        "  level: INFO\n",
        encoding="utf-8",
    )

    env = {
        **os.environ,
        "ALICE_HOME": str(alice_home),
        "ALICE_YOLO_MODE": "1",
        "NO_COLOR": "1",
        "TERM": "dumb",
        "PYTHONPATH": str(REPO_ROOT),
    }
    for noisy in ("OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "ALICE_NOUS_AGENT_KEY"):
        env.pop(noisy, None)

    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "from alice_cli.main import main; main()",
            "--plan",
            "-z",
            "Look at target.py and tell me what you would change.",
        ],
        cwd=str(workdir),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )

    combined = proc.stdout + proc.stderr
    assert proc.returncode == 0, combined[-4000:]
    assert FINAL_TEXT in proc.stdout, combined[-4000:]

    # 1. Plan mode reached the wire: no write-capable tool was offered.
    assert model.requests, "the CLI never called the model"
    for i, request in enumerate(model.requests):
        names = _tool_names(request)
        if not names:
            continue  # auxiliary call (title, etc.)
        assert "write_file" not in names, (i, sorted(names))
        assert "patch" not in names, (i, sorted(names))
        assert "terminal" not in names, (i, sorted(names))
        assert "execute_code" not in names, (i, sorted(names))
        assert "read_file" in names, (i, sorted(names))

    # 2. The plan-mode contract is in the system prompt.
    first = model.requests[0]
    system_text = "\n".join(
        m.get("content") or ""
        for m in first.get("messages", [])
        if m.get("role") == "system"
    )
    assert "Plan mode" in system_text
    assert "read-only" in system_text

    # 3. The hallucinated write was rejected, not executed.
    assert not (workdir / "pwned.txt").exists()
    # Look at the agent's own conversation calls (auxiliary calls such as the
    # session titler carry no tools and are irrelevant here).
    tool_requests = [r for r in model.requests if _tool_names(r)]
    assert len(tool_requests) >= 3, [len(r.get("messages", [])) for r in tool_requests]

    wire = json.dumps(tool_requests)
    assert "read-only session (plan mode)" in wire, wire[-3000:]
    assert "write_file" in wire, wire[-3000:]

    # 4. The allowed read went through and its result came back to the model.
    assert "VALUE = 42" in wire, wire[-3000:]

    # 5. Per-turn telemetry was recorded (turns.jsonl is written even in -z,
    # where logging.disable() mutes the console/file handlers).
    turns_path = alice_home / "logs" / "turns.jsonl"
    assert turns_path.exists(), combined[-3000:]
    records = [json.loads(line) for line in turns_path.read_text().splitlines() if line.strip()]
    assert records, "no turn records"
    last = records[-1]
    assert last["api_calls"] >= 3, last
    assert last["prompt_tokens"] > 0, last
    # The rejected write never reaches the executor; only the read does.
    assert last["tool_calls"] >= 1, last
    assert last["tools"]["read_file"]["count"] == 1, last["tools"]
