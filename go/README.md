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
| `alice cli [--resume ID] [--model NAME] [--cwd DIR] [--plain]` | The Go classic CLI (M2) |
| `alice config path` / `env-path` | Print the resolved config / .env path |
| `alice config get <key>` | Read a dotted config key |
| `alice config set <key> <value>` | Edit config.yaml in place (comment-preserving) |
| `alice config unset <key>` | Remove a config key |
| `alice host help` | Help generated from the command table |

### Classic CLI

The Go frontend over the same JSON-RPC gateway the TUI and desktop use.

```bash
alice cli                 # full-screen TUI when stdout is a terminal
alice cli --plain         # line mode (pipes, scripts, CI)
alice cli --resume <id>   # attach to a stored session
alice cli --model <name>  # model override for a new session
alice cli --cwd <dir>     # session working directory (default: $PWD)
```

Local commands: `/help`, `/new`, `/resume`, `/sessions`, `/model`,
`/interrupt`, `/clear`, `/status`, `/quit`. Everything else is forwarded to
`slash.exec`, so skills, plugins and backend commands work without being
reimplemented. In the TUI, `/sessions` and `/model` open interactive pickers
(↑/↓ · enter · esc).

Keys: `enter` submits, `ctrl+j` inserts a newline, `ctrl+c` interrupts the turn
(or quits when idle), `ctrl+d` quits, `esc` clears the input. Blocking prompts
render inline: approvals take `y`/`a`/`n`, clarify accepts a choice number,
sudo/secret mask the input.

`internal/cli` holds the engine (session lifecycle, typed event stream, slash
dispatch) plus two frontends — a bubbletea TUI and a line REPL — so both share
one implementation of the behaviour.

Parity with `cli.py`:

| Area | Status |
|---|---|
| Streaming reply + reasoning | implemented |
| Tool call/progress rendering | implemented |
| Approvals, clarify, sudo, secret | implemented |
| Session create/resume/list, interactive picker | implemented |
| Model picker + per-session switch | implemented |
| Slash commands (skills, plugins, backend) | delegated to `slash.exec` |
| Interrupt / stop | implemented |
| Markdown rendering | headings, lists, quotes, rules, code fences, bold/italic/inline code, links |
| Skin palettes | `default`, `ares`, `mono`, `slate` from `gateway.ready`; unknown → default |
| Voice, pets, journey overlays, inline images | not implemented (TUI-only Python features) |

Flipping the default `alice` behaviour to this CLI is a one-line routing change
once that parity is accepted; today it is opt-in via `alice cli`.

E2E against the real backend (one real model call):

```bash
ALICE_CLI_E2E=1 go test ./internal/cli -run Gateway -v
```


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

## Configuration

`config.yaml` editing is native for the keys that only need the user file:

| Subcommand | Behaviour |
|---|---|
| `config path`, `config env-path` | resolved paths |
| `config get <key>` | dotted path, numeric list indices (`providers.0.name`) |
| `config set <key> <value>` | edits in place; type coercion matches Python (`true/yes/on`, `false/no/off`, ints, floats); `api_base` is normalised to `model.base_url` |
| `config unset <key>` | removes the key or list element |
| `config check` | schema version vs latest + status of every optional env var |
| `config dump` | merged defaults+user config as YAML, secret leaves masked |
| `config migrate` | natively applies 28→32 (write_mode → write_approval, verify_on_stop flips) and bumps the schema version; schemas < 28 or configs with `mcp_servers` delegate to Python |

Properties:

- **Comments and key order survive** the write (yaml.Node editing). Python's
  current `config set` uses `safe_load` and *drops* comments — the Go path is
  strictly less destructive.
- **Atomic write**: temp file + fsync + rename, preserving the existing mode
  (0600 for new files).
- **Managed scope respected**: keys pinned by `$ALICE_MANAGED_DIR/config.yaml`
  (or `/etc/alice/config.yaml`) are refused with the administrator message.
- **Secrets never written to YAML**: API-key-shaped names
  (`*_API_KEY`, `*_TOKEN`, `TERMINAL_SSH*`, plus Python's explicit list) and
  `terminal.*` keys are delegated to Python, which routes them to `.env` or
  the terminal env mirror. Echoed values for credential-shaped leaves are
  masked.
- `show`, `edit` and `migrate` for schemas below 28 stay delegated — the panel
  depends on auth + skill discovery, the editor is interactive, and the older
  versions need env moves, plugin grandfathering and MCP hardening. Native
  migrations are **non-interactive** (no key prompts); use `alice setup` or
  `config set` for new credentials.

The embedded `internal/config/schema.json` is generated from Python's
`DEFAULT_CONFIG` + `OPTIONAL_ENV_VARS`:

```bash
python scripts/gen_go_config_schema.py
ALICE_CONFIG_SCHEMA_FRESHNESS=1 go test ./internal/config -run SchemaFreshness -v
```

Parity is pinned by opt-in tests that run the same operation through Python and
Go on identical homes and compare the parsed YAML:

```bash
ALICE_CONFIG_PARITY=1 go test ./internal/host -run ConfigSetParity -v
ALICE_CONFIG_MIGRATION_PARITY=1 go test ./internal/config -run MigrationParity -v
```

The migration harness covers schema versions 28–31 (the native range); the
same real-world check was run against a full 13 KB config and produced an
identical tree in both implementations.

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

M1 (host operations) and M2 (classic CLI) are complete. Business subcommands
are **not** incremental on top of the host: each depends on a Python core that
has to be ported first, and doing it without parity tests would violate this
repo's own rules (port = delete, E2E validation, no change-detector tests).

| Command | Blocker | Rough size |
|---|---|---|
| `config show/edit` | curated panel needs auth + skill discovery; editor is interactive | 0.5–1 dev-month |
| `config migrate` for schemas < 28 | env moves, plugin grandfathering, MCP hardening | 1–1.5 dev-months |
| `setup` | interactive wizard over config + auth + model catalog | 2–3 |
| `auth`, `model` | OAuth device flows, credential pool, keychain, 28 provider profiles | 3–4 |
| `cron` mutations | schedule parser, job schema, cross-process locking, delivery targets | 1–2 |
| `kanban` | SQLite board + dispatcher + worker protocol | 2–3 |

Native today: `config path`, `env-path`, `get`, `set`, `unset`, `check`, `dump`,
and the `migrate` no-op fast path.
