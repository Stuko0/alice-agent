# Langfuse Observability Plugin

This plugin ships bundled with Alice but is **opt-in** — it only loads when
you explicitly enable it.

## Enable

Pick one:

```bash
# Interactive: walks you through credentials + SDK install + enable
alice native  # → Langfuse Observability

# Manual
pip install langfuse
alice plugins enable observability/langfuse
```

## Required credentials

Set these in `~/.alice/.env` (or via `alice native`):

```bash
ALICE_LANGFUSE_PUBLIC_KEY=pk-lf-...
ALICE_LANGFUSE_SECRET_KEY=sk-lf-...
ALICE_LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or your self-hosted URL
```

Without the SDK or credentials the hooks no-op silently — the plugin fails
open.

## Verify

```bash
alice plugins list                 # observability/langfuse should show "enabled"
alice chat -q "hello"              # then check Langfuse for a "Alice turn" trace
```

## Optional tuning

```bash
ALICE_LANGFUSE_ENV=production       # environment tag
ALICE_LANGFUSE_RELEASE=v1.0.0       # release tag
ALICE_LANGFUSE_SAMPLE_RATE=0.5      # sample 50% of traces
ALICE_LANGFUSE_MAX_CHARS=12000      # max chars per field (default: 12000)
ALICE_LANGFUSE_DEBUG=true           # verbose plugin logging
```

## Disable

```bash
alice plugins disable observability/langfuse
```
