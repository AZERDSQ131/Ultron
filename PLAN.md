# ULTRON — Plan

What we're building, in order. Updated as decisions change — this is the source of truth for scope, ahead of any individual session's memory.

## Vision

A personal AI agent built from scratch, replacing OpenClaw and Hermes Agent. The whole point of building it ourselves is control: no black-box agent loop, no framework-imposed defaults we didn't choose. Two end products:

1. **The classic agent** — a conversational agent reachable via Telegram that can act on the user's behalf (read/organize files, manage mail, etc.), the same category of thing OpenClaw does, minus the parts that caused loss of control.
2. **The vibe-coding app** — a Codex-style app for coding entirely with AI: one main conversation that, behind the scenes, spins up background sub-agents to manage individual projects.

We are currently building **#1 only**. #2 is deliberately deferred — noted here so it isn't forgotten, not started.

## Phase 1 — Loop + memory (done)

- Terminal chat loop
- Nemotron (NVIDIA API) as the only model
- LangGraph as the orchestrator — we own the state and the loop, not a packaged agent harness
- Classic durable memory in a human-readable `MEMORY.md`
- Persistent conversation state via a local SQLite checkpoint database (`src/core/memory/checkpointer.ts`,
  `ultron-state.sqlite3`) — survives process restarts, not just an in-memory `MemorySaver`
- Token-by-token streaming
- Ctrl+C interrupts cleanly at any point, including mid-response
- No Docker, no manual confirmations, no audit logs — explicit choices, see [CLAUDE.md](CLAUDE.md)

## Additional entry point — local web interface (done)

- `src/interfaces/web/server.ts` + `src/interfaces/web/public/` — a local web UI, requested directly by the user
  alongside the CLI (they work with Codex on the terminal side, ULTRON's web UI covers the browser)
- Same `buildGraph()` core, same tool set and streaming behavior as the CLI — plain `node:http`
  server (no Express) and a vanilla HTML/CSS/JS frontend (no framework), consistent with owning
  the loop instead of delegating to one
- Shares the CLI's thread (`ultron-main`) and the same SQLite checkpoint database — the CLI and
  the web UI are two views onto one running conversation, not two disconnected sessions. Each
  process opens its own connection to the same file; a write from one is visible to the other on
  its next read (see `src/core/memory/checkpointer.ts`)
- `/compact`, `/retry` and `/archive` are exposed as web API routes too (`/api/compact`,
  `/api/turn` with `retry: true`, `/api/archive`, `/api/resume`) and recognized as slash commands
  by the web frontend, so commands behave the same regardless of which interface issues them
- `pnpm web` (dev) / `pnpm start:web` (compiled) — port via `WEB_PORT`, default `4173`

Chosen over a single always-on server process that the CLI would connect to as a client: that
would force the server to always be running first and would centralize a single point of failure.
Two independent processes sharing one SQLite file keeps the CLI fully usable standalone (as before)
while still merging state — the trade-off is that two writes at the exact same instant from both
interfaces could theoretically race; acceptable for a single-user local tool used from one
interface at a time.

## Phase 2 — Telegram interface

- Replace/complement the terminal with a Telegram bot (grammY)
- Same LangGraph core and `MEMORY.md` — Telegram is just a new entry point, not a rewrite
- Streaming responses via Telegram's Bot API message editing

## Phase 3 — Tools (in progress)

- Tools declared with an explicit scope: `read` / `write` / `destructive` (kept in code for clarity even though confirmation gates are off by default per current settings) — see `src/core/tools/index.ts`
- Done: `run_shell_command`, `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `fetch_url`, `http_request`, `web_search`, `list_processes`, `kill_process` — the web/process tools are modeled on OpenClaw's own tool categories (`exec`, `web_search`, `web_fetch`, `process`)
- Still to come: mail, calendar (both need OAuth setup — bigger lift than the filesystem/shell tools)
- Background scheduled tasks (cron-style) once the core loop is trusted

## Phase 4 — Vibe-coding app (deferred, not started)

- Separate app, Codex-style interface
- One main conversation orchestrates background sub-agents, each managing a project
- Will reuse the tool/memory layers built in phases 1–3 rather than starting over

## Ground rules carried across every phase

- Full research and the reasoning behind these choices: [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) (French)
- Security posture is intentionally light by user choice (no sandboxing, no confirmations, no logs) — do not silently reintroduce any of it
- No sub-agents used to *build* ULTRON itself — this project is coded directly
- Every code change is committed and pushed as it happens, no batching
