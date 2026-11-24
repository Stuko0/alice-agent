# Alice Go host

First rung of the "Option C" migration: a Go binary that owns process
startup, path/runtime resolution and, progressively, the operational
subcommands. The agent loop and the gateway keep running in Python.

**Nothing here changes user-visible behaviour yet.** The binary delegates every
command it does not implement natively to `python -m alice_cli.main`.

## Build

```bash
cd go
make build        # -> go/bin/alice
make check        # gofmt + vet + tests
```

## What is native today

| Command | Behaviour |
|---|---|
| `alice host env` | JSON report: resolved `ALICE_HOME`, Python runtime, build info |
| `alice host rpc <method> [json]` | Spawn the gateway, wait for `gateway.ready`, call one RPC, print the result |
| `alice host help` | Host-specific help |
| everything else | Delegated verbatim to the Python backend |

`alice version` is **deliberately delegated**: the Python implementation also
performs an update check, and reimplementing it in Go would create a second
source of truth before the conformance harness exists.

```bash
./bin/alice host rpc session.list
./bin/alice host rpc session.create '{"cwd":"/repo"}'
```

## Protocol

`internal/protocol` implements the wire contract documented in
[`docs/protocol/json-rpc.md`](../docs/protocol/json-rpc.md): request/response/
event frames, error codes, and NDJSON framing with a 64 MiB frame cap.

`internal/rpcclient` is the reusable client on top of it: it spawns the
backend, waits for `gateway.ready`, matches responses to requests by id, and
delivers events on a channel. This is the foundation the Go CLI will use.

The contract survives drift thanks to two tests:

- `tests/tui_gateway/test_rpc_contract_doc.py` — the documented method catalog
  must equal the live `tui_gateway.server._methods` registry.
- `go/internal/protocol/gateway_integration_test.go` — opt-in, spawns the real
  Python gateway and checks `gateway.ready`, a success response, `-32601`,
  `-32602` and a clean shutdown:

```bash
cd go
make integration
```


## Runtime resolution

`ALICE_HOME` (mirrors `alice_constants.get_alice_home()`):

1. `ALICE_HOME` env var
2. Windows: `%LOCALAPPDATA%\alice`
3. everything else: `~/.alice`

Profiles (`-p` / `--profile`) are **not** parsed here. Python owns that
parsing, including the `mcp add --args` passthrough region; duplicating it in
Go is how the two implementations drift.

Python interpreter (first existing file wins):

1. `ALICE_PYTHON` (explicit escape hatch)
2. `<repo>/.venv` then `<repo>/venv`, where `<repo>` is inferred from the host
   binary location (`go/bin/alice` → repo root)
3. the same two venvs in the current working directory
4. `$ALICE_HOME/alice-agent/{.venv,venv}` (worktrees sharing a venv)
5. `python3`, then `python`, from `PATH`

## Design notes

- On POSIX the child is launched with `exec(2)`, so the Python process inherits
  the terminal, signal handling and exit status with no glue code. On Windows
  the host stays alive as the parent.
- The host sets `ALICE_HOST=go` when it is not already set, so a running
  process can tell how it was launched.
- `Runner` is an interface: tests inject a fake and never spawn Python.

## Next steps

1. Port `alice doctor` and `alice config` (low risk, high diagnostic value).
2. Add the JSON-RPC client and the protocol contract (milestone M0).
3. Port the classic CLI as a client of that protocol (milestone M2).

See `docs/` in the community repo for the full migration plan.
