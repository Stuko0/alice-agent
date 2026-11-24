# Alice Go host

The Go entry point for Alice Agent. It owns process startup, runtime and
profile resolution, diagnostics, log access and supervision of the Python
backend. The agent loop and the gateway keep running in Python (Option C).

**Nothing user-visible changes unless you invoke a `host` command**: every
command the host does not implement natively is handed to
`python -m alice_cli.main` with its original argv.

## Build

```bash
cd go
make build        # -> go/bin/alice
make check        # gofmt + vet + tests
make integration  # opt-in: speaks the wire protocol to the real gateway
make install      # -> ~/.local/bin/alice (PREFIX to override)
```

## Commands

| Command | Behaviour |
|---|---|
| `alice host env` | JSON: resolved `ALICE_HOME`, Python runtime, build info |
| `alice host doctor [--json] [--deep]` | Check home, interpreter, config, state; `--deep` performs a real `gateway.ready` handshake |
| `alice host logs [name] [-n N] [-f]` | Tail `agent` (default), `errors`, `gateway`, `tui` or `host` logs |
| `alice host rpc <method> [json]` | Spawn the gateway, wait for `gateway.ready`, call one RPC, print the result |
| `alice host supervise [--max-restarts N] [--backoff-max 30s] -- <cmd...>` | Run a child and restart it with exponential backoff |
| `alice host help` | Help generated from the command table |

Examples:

```bash
./bin/alice host doctor --deep
./bin/alice host logs gateway -n 100 -f
./bin/alice host rpc session.list
./bin/alice host supervise --max-restarts 5 -- \
  .venv/bin/python -m alice_cli.main gateway run
./bin/alice -p work host env          # profile-aware diagnostics
```

## Routing

`Main` pre-parses **leading global flags only** (`-p/--profile`, plus the
value-taking flags the CLI already defines). If the first positional argument
is `host`, the command runs natively; otherwise the original argv is delegated
verbatim, so Python keeps owning its own argument parsing (including the
`mcp add --args` passthrough region).

Unknown leading flags are never guessed: the host delegates and lets Python
report the error.

## Profiles

`ALICE_HOME` resolution mirrors `alice_cli.main._apply_profile_override` and
`alice_constants.get_alice_home`:

1. an explicit `-p NAME` (validated against `^[a-z0-9][a-z0-9_-]{0,63}$`; a
   missing profile is an error, exactly like Python);
2. the sticky `active_profile` file under the default root, unless
   `ALICE_S6_SUPERVISED_CHILD` is set or `ALICE_HOME` already points at a
   profile directory;
3. `ALICE_HOME`;
4. the platform default (`%LOCALAPPDATA%\alice` on Windows, `~/.alice` elsewhere).

The default root collapses `<root>/profiles/<name>` back to `<root>` so profile
operations can see every profile.

Profiles are only interpreted for **native** commands. Delegated commands get
their original argv, and Python re-resolves the profile itself.

## Python resolution

First existing file wins:

1. `ALICE_PYTHON` (explicit escape hatch)
2. `<repo>/.venv` then `<repo>/venv`, with `<repo>` inferred from the host
   binary location (`go/bin/alice` → repo root)
3. the same two venvs in the current working directory
4. `$ALICE_HOME/alice-agent/{.venv,venv}` (worktrees sharing a venv)
5. `python3`, then `python`, from `PATH`

## Supervisor

`internal/supervisor` is policy-only: start, restart on non-zero exit with
exponential backoff, stop on context cancellation or signal. On POSIX the child
gets its own process group so `SIGTERM` reaches the tree it spawned; Windows
kills the direct child (job objects are future work).

`alice host supervise` forwards `SIGINT`/`SIGTERM` and exits with the child's
last status once the restart budget is exhausted.

## Protocol

`internal/protocol` implements the wire contract documented in
[`docs/protocol/json-rpc.md`](../docs/protocol/json-rpc.md): request/response/
event frames, error codes, and NDJSON framing with a 64 MiB cap.

`internal/rpcclient` is the reusable client on top of it: it spawns the
backend, waits for `gateway.ready`, matches responses to requests by id, and
delivers events on a channel. This is the foundation the Go CLI will use.

Two tests keep the contract honest:

- `tests/tui_gateway/test_rpc_contract_doc.py` — the documented method catalog
  must equal the live `tui_gateway.server._methods` registry.
- `go/internal/protocol/gateway_integration_test.go` — opt-in, spawns the real
  Python gateway and checks `gateway.ready`, a success response, `-32601`,
  `-32602` and a clean shutdown (`make integration`).

## Scope boundary

M1 (this host) covers the operations layer: routing, profiles, diagnostics,
logs, RPC access and supervision. Business subcommands (`setup`, `config`,
`auth`, `model`, `cron`, `kanban`) are still Python and will be ported one at a
time, each deleting its Python counterpart in the same change.
