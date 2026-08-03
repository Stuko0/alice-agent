---
name: graphify
description: "Project analysis and graph extraction using Graphify"
platforms: ["cli", "telegram", "discord"]
---

# Graphify Skill

Graphify is a powerful tool to extract, analyze, and visualize a codebase as a knowledge graph.
It parses the codebase and generates `graph.json` and a compact summary in `GRAPH_REPORT.md`.

## Instructions

Whenever you need to understand the big picture of a codebase, track complex dependencies, or find central modules (god-nodes), you should run Graphify.

1. **Extract Graph:** Run `alice graphify` (or `/graphify` in the CLI) in the root of the workspace. This is required instead of running `uv run graphify` directly, because the `alice` wrapper automatically injects your configured LLM API keys and backend settings into the extraction pipeline.
   - For a deeper semantic extraction, use the `--deep` flag: `alice graphify --deep` (or `/graphify --deep`).
2. **Review Context:** Once generated, Alice automatically reads `GRAPH_REPORT.md` on the next turn. You don't need to manually read it if it's already generated, but you can read `GRAPH_REPORT.md` if you need to refresh your memory.
3. **Graph Data:** If you need exact relationship mappings, read `graph.json` to find edge connections.

## Useful Queries & Workflows

- **Dependency Tracing**: Search `graph.json` for specific modules to see what they depend on or what depends on them.
- **God-Nodes**: Look for nodes in `GRAPH_REPORT.md` or `graph.json` with exceptionally high edge counts.
- **Incremental Updates**: If the codebase changes significantly, suggest to the user to run `alice graphify` again to regenerate the graph.

## Periodic Generation

If you have been making significant architectural changes, proactively ask the user: "Should we run `/graphify` again to update our project map?"
