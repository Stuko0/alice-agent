# JSON-RPC protocol — agent backend ⇄ UI clients

> **Audience:** backend and client developers
> **Source of truth:** `tui_gateway/server.py` (`@method` registry), `tui_gateway/transport.py`, `tui_gateway/ws.py`
> **Status:** frozen contract (2026-11-24). Additive changes only — see [Compatibility](#compatibility).

This is the boundary between the UI clients (Ink TUI, Electron/Wails desktop,
web dashboard, iOS) and the agent backend. Anything that speaks this protocol
on the other side of the pipe is interchangeable: the Python `AIAgent` today,
the Go engine in the enterprise edition later. **Clients must never depend on
Python internals** — only on the frames below.

## Transports

| Transport | How | Notes |
|---|---|---|
| stdio | `alice --tui` spawns the gateway; one JSON frame per line on stdin/stdout | Default for the Ink TUI |
| WebSocket | `/api/ws` on `alice serve` / `alice dashboard` | Same frames, no length prefix |

Both transports are **newline-delimited JSON** (NDJSON). Binary data is
base64-encoded inside JSON (`image.attach_bytes`, terminal output chunks).

The server emits a `gateway.ready` event immediately after the connection is
accepted. Clients must wait for it before issuing requests that need a skin or
config snapshot.

## Framing

### Request (client → server)

```json
{"jsonrpc": "2.0", "id": "req-1", "method": "session.create", "params": {"cwd": "/repo"}}
```

- `id` — string or number, opaque, echoed back unchanged.
- `method` — non-empty string; see the [method catalog](#method-catalog).
- `params` — **must be an object** (`{}` when omitted). Arrays are rejected.

### Success response (server → client)

```json
{"jsonrpc": "2.0", "id": "req-1", "result": {"session_id": "s-abc"}}
```

### Error response

```json
{"jsonrpc": "2.0", "id": "req-1", "error": {"code": 4009, "message": "session busy"}}
```

### Event (server → client, unsolicited)

```json
{"jsonrpc": "2.0", "method": "event", "params": {"type": "message.delta", "session_id": "s-abc", "payload": {"text": "Hel"}}}
```

Events carry **no `id`**. `params.type` is the event name; `params.session_id`
identifies the conversation (omitted for connection-scoped events such as
`gateway.ready`). The event body — if any — is nested under **`params.payload`**;
`type` and `session_id` are its only siblings. Events without a body (for
example `message.start`) omit `payload` entirely.

Requests are dispatched either inline (fast handlers) or on a worker pool
(long handlers). A pooled request still produces exactly one response frame,
with the same `id`, written by the worker through the request's bound transport.
Clients must therefore match responses by `id` and must not assume ordering
between a response and concurrently emitted events.

## Error codes

| Code | Meaning |
|---|---|
| `-32600` | Invalid request (not an object, missing/invalid `method`, non-object `params`) |
| `-32601` | Unknown method |
| `-32602` | Invalid params |
| `4000`–`4999` | Application errors raised by handlers (e.g. `4009` session busy) |

Codes are the contract. `message` is human-facing copy and may change.

## Session lifecycle

```text
client                                   server
  │  ── gateway.ready (event) ◀────────────  │  once per connection
  │  ── session.create ──────────────────▶   │
  │  ◀──────────────── {session_id} ───────  │
  │  ── prompt.submit ───────────────────▶   │
  │  ◀── message.start ────────────────────  │
  │  ◀── tool.generating / tool.start ─────  │
  │  ◀── tool.complete ────────────────────  │
  │  ◀── reasoning.delta / message.delta ──  │  streamed
  │  ◀── message.complete ─────────────────  │
  │  ── session.history ─────────────────▶   │
  │  ◀──────────────── {messages:[…]} ─────  │
```

Blocking prompts are the only request/event pairs that require a client
response: `approval.request` → `approval.respond`, `clarify.request` →
`clarify.respond`, `sudo.request` → `sudo.respond`, `secret.request` →
`secret.respond`. The server holds the turn until the matching `*.respond`
arrives or the session is interrupted.

## Core events

Payload keys below live under **`params.payload`**. Emitters may add fields, and
clients must ignore unknown keys.

| Event | When | Payload |
|---|---|---|
| `gateway.ready` | Once per connection | `{skin}` |
| `message.start` | Assistant turn begins | — |
| `message.delta` | Streamed reply token(s) | `text` |
| `message.complete` | Final reply | `text` |
| `reasoning.delta` | Streamed reasoning token(s) | `text` |
| `reasoning.available` | Reasoning text is available | `text`, optional `verbose` |
| `thinking.delta` | Provider "thinking" status line | `text` |
| `tool.generating` | Model is producing a tool call | `name` |
| `tool.start` | Tool invocation started | `tool_id`, `name`, `context`, optional `args_text` |
| `tool.complete` | Tool finished | `tool_id`, `name`, `args`, `result`, `duration_s`, `summary`, optional `inline_diff`/`todos` |
| `approval.request` | Command needs approval | `command` (redacted), `tool_id` |
| `clarify.request` | Agent asks the user a question | `question`, `options` |
| `sudo.request` / `secret.request` | Privileged input needed | prompt metadata |
| `session.info` | Session metadata changed | session info object |
| `verification.status` | Coding verification evidence changed | status object |
| `terminal.read.request` / `terminal.close` / `terminal.cwd` / `terminal.resize` | Embedded terminal lifecycle | — |
| `agent.terminal.output` | Background terminal output chunk | `process_id`, `chunk` |
| `handoff.request` / `handoff.state` / `handoff.fail` | Session handoff to a messaging platform | handoff state |
| `process.list` / `process.kill` / `process.stop` | Background process registry | process rows |

Streaming events (`message.delta`, `reasoning.delta`, `thinking.delta`) may be
coalesced by the transport into batches; treat every frame as zero or more
tokens, never as exactly one.

## Method catalog

Generated from the `@method(...)` registry in `tui_gateway/server.py`. The
`tests/tui_gateway/test_rpc_contract_doc.py` test fails when this catalog and
the registry disagree, so the list below is authoritative.

<!-- BEGIN METHOD CATALOG -->

### `agents.*`

| Method | Description |
|---|---|
| `agents.list` | — |

### `approval.*`

| Method | Description |
|---|---|
| `approval.respond` | — |

### `billing.*`

| Method | Description |
|---|---|
| `billing.auto_reload` | PATCH /api/billing/auto-top-up → {ok:true} or typed error (Screen 2). |
| `billing.charge` | POST /api/billing/charge → {ok, chargeId} or a typed error envelope. |
| `billing.charge_status` | GET /api/billing/charge/{id} → {ok, status, ...} or typed error. |
| `billing.state` | GET /api/billing/state → serialized BillingState (Screen 1 + 5). |
| `billing.step_up` | Run the lazy billing:manage step-up device flow → {ok, granted}. |

### `browser.*`

| Method | Description |
|---|---|
| `browser.manage` | — |

### `clarify.*`

| Method | Description |
|---|---|
| `clarify.respond` | — |

### `cli.*`

| Method | Description |
|---|---|
| `cli.exec` | Run `python -m alice_cli.main` with argv; capture stdout/stderr (non-interactive only). |

### `clipboard.*`

| Method | Description |
|---|---|
| `clipboard.paste` | — |

### `command.*`

| Method | Description |
|---|---|
| `command.dispatch` | — |
| `command.resolve` | — |

### `commands.*`

| Method | Description |
|---|---|
| `commands.catalog` | Registry-backed slash metadata for the TUI — categorized, no aliases. |

### `complete.*`

| Method | Description |
|---|---|
| `complete.path` | — |
| `complete.slash` | — |

### `config.*`

| Method | Description |
|---|---|
| `config.get` | — |
| `config.set` | — |
| `config.show` | — |

### `credits.*`

| Method | Description |
|---|---|
| `credits.view` | Structured Nous credit view for the TUI /credits command. |

### `cron.*`

| Method | Description |
|---|---|
| `cron.manage` | — |

### `delegation.*`

| Method | Description |
|---|---|
| `delegation.pause` | — |
| `delegation.status` | — |

### `file.*`

| Method | Description |
|---|---|
| `file.attach` | Stage a non-image file attachment into the session workspace. |

### `handoff.*`

| Method | Description |
|---|---|
| `handoff.fail` | Mark an in-flight handoff as failed so the user can retry. |
| `handoff.request` | Queue a handoff of this session to a messaging platform. |
| `handoff.state` | Poll the handoff state for a session. |

### `image.*`

| Method | Description |
|---|---|
| `image.attach` | — |
| `image.attach_bytes` | Attach an image to the session from base64 bytes (remote-client path). |
| `image.detach` | — |

### `input.*`

| Method | Description |
|---|---|
| `input.detect_drop` | — |

### `insights.*`

| Method | Description |
|---|---|
| `insights.get` | — |

### `learning.*`

| Method | Description |
|---|---|
| `learning.delete` | Delete a journey node — skills are archived (restorable), memories removed. |
| `learning.detail` | Current content of a journey node, for an edit prefill. |
| `learning.edit` | Rewrite a journey node's content (SKILL.md or memory chunk). |
| `learning.frames` | Pre-render the learning timeline for the TUI ``/journey`` overlay. |

### `llm.*`

| Method | Description |
|---|---|
| `llm.oneshot` | Run a single stateless LLM request outside any conversation. |

### `model.*`

| Method | Description |
|---|---|
| `model.disconnect` | Remove credentials for a provider. |
| `model.options` | — |
| `model.save_key` | Save an API key for a provider, then return its refreshed model list. |

### `paste.*`

| Method | Description |
|---|---|
| `paste.collapse` | — |

### `pdf.*`

| Method | Description |
|---|---|
| `pdf.attach` | Attach a PDF by rendering each page to PNG and queuing the pages. |

### `pet.*`

| Method | Description |
|---|---|
| `pet.cancel` | Signal an in-flight ``pet.generate``/``pet.hatch`` (by token) to stop. |
| `pet.cells` | — |
| `pet.disable` | — |
| `pet.export` | — |
| `pet.gallery` | — |
| `pet.generate` | Generate candidate base looks for a new pet (the draft/variant step). |
| `pet.generate.status` | Whether pet generation is possible right now. |
| `pet.hatch` | Turn a chosen base draft into a full pet — installed but NOT yet active. |
| `pet.info` | — |
| `pet.info.meta` | — |
| `pet.remove` | — |
| `pet.rename` | — |
| `pet.scale` | — |
| `pet.select` | — |
| `pet.thumb` | — |

### `plugins.*`

| Method | Description |
|---|---|
| `plugins.list` | — |
| `plugins.manage` | List installed plugins with activation state, or toggle one on/off. |

### `preview.*`

| Method | Description |
|---|---|
| `preview.restart` | — |

### `process.*`

| Method | Description |
|---|---|
| `process.kill` | Kill ONE background process — scoped to the caller's session so one |
| `process.list` | Session-scoped view of the background process registry (desktop status stack). |
| `process.stop` | — |

### `project.*`

| Method | Description |
|---|---|
| `project.facts` | Structured project facts for a cwd — manifests, package manager, the |

### `projects.*`

| Method | Description |
|---|---|
| `projects.add_folder` | — |
| `projects.archive` | — |
| `projects.create` | — |
| `projects.delete` | — |
| `projects.discover_repos` | Repos for the desktop overview: scanned-from-disk (cached) ∪ session-derived. |
| `projects.for_cwd` | — |
| `projects.get` | — |
| `projects.list` | — |
| `projects.project_sessions` | Fully hydrated lanes (repo -> lane -> session rows) for one project, |
| `projects.record_repos` | Persist git repo roots found by the client's filesystem scan, then return |
| `projects.remove_folder` | — |
| `projects.set_active` | — |
| `projects.set_primary` | — |
| `projects.tree` | Authoritative project overview: project -> repo -> lane structure with |
| `projects.update` | — |

### `prompt.*`

| Method | Description |
|---|---|
| `prompt.background` | — |
| `prompt.submit` | — |

### `reload.*`

| Method | Description |
|---|---|
| `reload.env` | Re-read ``~/.alice/.env`` into the gateway process via |
| `reload.mcp` | — |

### `rollback.*`

| Method | Description |
|---|---|
| `rollback.diff` | — |
| `rollback.list` | — |
| `rollback.restore` | — |

### `secret.*`

| Method | Description |
|---|---|
| `secret.respond` | — |

### `session.*`

| Method | Description |
|---|---|
| `session.activate` | Attach the frontend to an already-live TUI session. |
| `session.active_list` | Return live TUI sessions in this gateway process. |
| `session.branch` | — |
| `session.close` | — |
| `session.compress` | — |
| `session.context_breakdown` | — |
| `session.create` | — |
| `session.cwd.set` | — |
| `session.delete` | Delete a stored session and its on-disk transcript files. |
| `session.history` | — |
| `session.interrupt` | — |
| `session.list` | — |
| `session.most_recent` | Return the most recent human-facing session id, or ``None``. |
| `session.resume` | — |
| `session.save` | — |
| `session.status` | — |
| `session.steer` | Inject a user message into the next tool result without interrupting. |
| `session.title` | — |
| `session.undo` | — |
| `session.usage` | — |

### `setup.*`

| Method | Description |
|---|---|
| `setup.runtime_check` | Strict provider check: does the configured/default model actually resolve to a usable runtime? |
| `setup.status` | — |

### `shell.*`

| Method | Description |
|---|---|
| `shell.exec` | — |

### `skills.*`

| Method | Description |
|---|---|
| `skills.manage` | — |
| `skills.reload` | — |

### `slash.*`

| Method | Description |
|---|---|
| `slash.exec` | — |

### `spawn_tree.*`

| Method | Description |
|---|---|
| `spawn_tree.list` | — |
| `spawn_tree.load` | — |
| `spawn_tree.save` | — |

### `subagent.*`

| Method | Description |
|---|---|
| `subagent.interrupt` | — |

### `sudo.*`

| Method | Description |
|---|---|
| `sudo.respond` | — |

### `terminal.*`

| Method | Description |
|---|---|
| `terminal.read.respond` | — |
| `terminal.resize` | — |

### `tools.*`

| Method | Description |
|---|---|
| `tools.configure` | — |
| `tools.list` | — |
| `tools.show` | — |

### `toolsets.*`

| Method | Description |
|---|---|
| `toolsets.list` | — |

### `verification.*`

| Method | Description |
|---|---|
| `verification.status` | Best known coding verification evidence for a cwd/session. |

### `voice.*`

| Method | Description |
|---|---|
| `voice.record` | VAD-bounded push-to-talk capture, CLI-parity. |
| `voice.toggle` | CLI parity for the ``/voice`` slash command. |
| `voice.tts` | — |

<!-- END METHOD CATALOG -->

## Compatibility

1. **Additive only.** New methods, new events and new payload keys may appear
   in any release. Clients must ignore unknown events and unknown payload keys.
2. **No renames or removals without a new name.** A method that must change
   shape gets a new name and a deprecation window; the old one keeps working.
3. **`params` is always an object.** Optional fields must have server-side
   defaults so older clients keep working.
4. **Error codes are stable; messages are not.**
5. **One response per request**, matched by `id`, regardless of pooling.
6. **No Python objects on the wire.** Everything is JSON; binary is base64.

## Conformance

A non-Python backend is considered protocol-compatible when it passes:

```bash
scripts/run_tests.sh tests/tui_gateway/ -q
```

The suite pins the envelope shapes, the error codes, the dispatch behaviour and
the catalog above.

The Go side lives in `go/internal/protocol` and `go/internal/rpcclient`. It is
proven against the real Python gateway by an opt-in test that spawns it, waits
for `gateway.ready`, and exercises a success response plus the `-32601` and
`-32602` error paths:

```bash
cd go
make integration
```

The method catalog in this document is regenerated from the live registry; the
`tests/tui_gateway/test_rpc_contract_doc.py` test fails when the two drift, so
a Go implementation can treat this page as authoritative.
