# AGENTS.md — ULTRON

Instructions for any Codex session working on this repo.

## Project context

ULTRON is a personal AI agent built from scratch by the user, replacing OpenClaw and Hermes Agent. Reason for the switch: loss of control felt with those frameworks (see documented case where an OpenClaw agent deleted hundreds of emails despite being instructed to wait for approval — no technical checkpoint blocked the action).

The full research context (latest AI models, OpenClaw vs Hermes Agent comparison, security/architecture pitfalls to avoid, personal-life use case ideas) lives in [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) — written in French, kept as-is as a historical research artifact. Read it before any architecture decision that departs from the original plan.

## Architecture decisions already made

- **Model**: Nemotron (NVIDIA API) exclusively for now — no multi-provider setup.
- **Orchestrator**: LangGraph.js — the user owns the loop and the state, not a black-box framework.
- **Memory**: local SQLite checkpoint database (`ultron-state.sqlite3`), a hand-written `SqliteSaver` in `src/core/memory/checkpointer.ts` implementing LangGraph's `BaseCheckpointSaver` on Node's built-in `node:sqlite` (no `@langchain/langgraph-checkpoint-postgres`/`pg`, no `@langchain/langgraph-checkpoint-sqlite` — neither package's published versions match this project's `@langchain/core` ^0.3 / `langgraph` ^0.2 pin). Single persistent thread (`ultron-main`), shared by every entry point through that one database file.
- **Interface**: terminal (`src/interfaces/cli/`) and a local web UI (`src/interfaces/web/`) — both share the same core graph, memory and thread, so a message or a `/compact`/`/retry`/`/archive` from one shows up in the other. Telegram (`src/interfaces/telegram/`, not started) is next.
- **Language**: the project itself (code, comments, console labels, docs) is in English. ULTRON's conversational replies match whatever language the user is currently writing in (French in → French out, English in → English out) — this is enforced in [AGENT.md](AGENT.md). Do not let it default to English regardless of input language.
- **System prompt split**: [SOUL.md](SOUL.md) is personality only (voice, tone, examples). [AGENT.md](AGENT.md) is everything else — tool-use protocol, language matching, other operational rules. Don't fold one into the other; `src/core/graph.ts` concatenates both at startup.
- **Folder architecture**: `src/core/` is the shared engine (graph, LLM client, memory, tools) — it knows nothing about any particular interface. `src/interfaces/<name>/` is a presentation layer that imports from `src/core/` (never the reverse). Adding an interface (e.g. Telegram) means adding a new folder under `src/interfaces/`, not touching `src/core/`.
- **Security intentionally minimal**: the user explicitly asked for **no Docker, no hardened secret management, full bypass of manual permissions/confirmations**. This is NOT an oversight — do not reintroduce sandboxing or confirmation gates without an explicit request.
- **Logs**: explicitly not required by the user for now. Do not add a logging/audit system without being asked.
- **Stop**: Ctrl+C must interrupt the loop at any time, including mid LLM call (AbortController).
- **No sub-agents for coding this project**: the user explicitly asked not to use the Agent/sub-agent tool to develop ULTRON. Work directly.
- **Docs stay current**: update PLAN.md / README.md / AGENTS.md whenever a change makes them stale (new tool, new phase started, a decision changes) — don't let them drift from the actual code state.

## Known roadmap (do not build ahead of a request)

1. Loop + memory (done) + local web interface alongside the CLI (done, shares memory/commands via SQLite)
2. Telegram interface
3. Tools with scopes (read / write / destructive) — even with manual confirmations disabled by choice, keep scopes declared in code for clarity. In progress: shell + filesystem tools done (`src/core/tools/`), mail/calendar still pending (need OAuth).
4. Separate "Codex-style" app for vibe coding, with a main conversation orchestrating background sub-agents to manage projects. Do not start this without an explicit request — it was deliberately deferred during initial design.

## Stack

TypeScript (Node 24+) / pnpm / LangGraph.js / SQLite (`node:sqlite`, no external database) / `@langchain/openai` (OpenAI-compatible client pointed at the NVIDIA API).

## Git conventions

- `main`: stable
- `develop`: current work
- Commit + push on every code change (explicit user request — do not batch multiple changes into one deferred commit).
