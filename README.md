# ULTRON

ULTRON is a personal AI agent built from scratch with TypeScript, LangGraph,
Nemotron and local files. The goal is simple: keep ownership of the loop, the
state, the memory and the tools instead of hiding them behind an opaque agent
framework.

This repository is public from the beginning. It is an evolving experiment,
not a finished autonomous assistant. The architecture is intentionally small
enough to inspect, change and understand.

## Current state

The current version provides a terminal conversation loop with:

- Nemotron through NVIDIA's OpenAI-compatible API;
- a human-readable `MEMORY.md` for durable facts, preferences and context;
- token streaming, elapsed-time statistics with an exact generated-token count
  (real usage from NVIDIA's endpoint, not an estimate) and an estimated
  context gauge;
- basic terminal Markdown styling, including `**bold**` text;
- local slash commands for stopping, retrying, compacting and tuning reasoning;
- resumable text archives through `/archive` and `/resume`;
- twelve tools for shell commands, files, HTTP/web requests, processes and the current date/time;
- declared tool scopes (`read`, `write`, `destructive`) for architectural clarity;
- retry handling for transient API errors and malformed plain-text tool calls;
- clean Ctrl+C interruption, including during an in-flight model request.

A local web interface (`pnpm web`) is also available: same LangGraph core,
same streaming and tool-call behavior, served over HTTP with a small vanilla
HTML/CSS/JS frontend and no framework. It shares the same chats and memory
as the CLI through a local SQLite database (`ultron-state.sqlite3`) — a
message sent from one interface shows up in the other, and `/compact`,
`/retry` and `/archive` act on the same history no matter which interface
issued them. `GET /api/health` is a liveness probe (process uptime, model,
whether the shared SQLite file is reachable) — useful for a future Telegram
process or a supervisor script to check before assuming ULTRON is up.

Conversations are organized as chats, each with its own id and title,
listed in the web UI's sidebar (create, rename, delete, switch between
them). Running `/archive` from the CLI finalizes the current chat and
starts a new one, so the archived chat stays browsable and resumable from
the web sidebar — the CLI itself always resumes whichever chat was most
recently active on either interface.

Telegram is the next interface planned. Mail and calendar integrations are
still pending because they require OAuth. The separate Codex-style coding app
is explicitly deferred.

## Design principles

- Nemotron is the only model provider for now.
- LangGraph owns orchestration and state; there is no packaged agent harness.
- `SOUL.md` contains personality. `AGENT.md` contains operational rules.
- The security posture is intentionally minimal: there is no Docker sandbox,
  no per-action confirmation gate and no audit-log system at this stage.
- ULTRON is developed directly in this repository; coding sub-agents are not
  used to build it.

The minimal security posture is a conscious project decision, not a production
recommendation. The shell, filesystem, HTTP and process tools can affect the
machine running ULTRON. Run it only in an environment you are willing to give
that level of access to.

## Requirements

- Node.js 24 or newer;
- pnpm 9.15.4 or a compatible pnpm release;
- an NVIDIA API key with access to the configured Nemotron model.

## Setup

```bash
pnpm install
cp .env.example .env
```

Set `NVIDIA_API_KEY` in `.env`. Never commit `.env` or paste the key into an
issue, pull request or log. The file is ignored by Git by default.

Available configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NVIDIA_API_KEY` | required | NVIDIA API authentication |
| `NEMOTRON_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Model identifier |
| `NEMOTRON_BASE_URL` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible endpoint |
| `CONTEXT_WINDOW_TOKENS` | `262144` | CLI context-gauge reference |
| `WEB_PORT` | `4173` | Local web interface port |
| `DATABASE_PATH` | `ultron-state.sqlite3` | Shared checkpoint database (CLI + web) |

## Run and verify

```bash
pnpm dev          # run the terminal interface directly from TypeScript
pnpm web          # run the local web interface (http://localhost:4173 by default)
pnpm typecheck    # strict TypeScript check
pnpm build        # compile to dist/, including the web frontend assets
pnpm start        # run the compiled terminal interface
pnpm start:web    # run the compiled web interface
```

There are currently no automated tests or lint script. The first tests should
cover graph routing, retry and fake-tool-call handling, tool behavior,
interruption and classic file memory.

## Local commands

The terminal handles these commands without sending them to Nemotron:

| Command | Purpose |
| --- | --- |
| `/help` | Show available commands |
| `/status` | Show model, memory, tool and runtime status |
| `/context` | Show current context usage |
| `/stop` | Stop the active generation while it is running |
| `/retry` | Remove the previous assistant turn and run the last user message again |
| `/compact` | Summarize old session messages and keep the recent turns |
| `/think on\|low\|off` | Enable full reasoning, low-effort reasoning, or no reasoning |
| `/verbose on\|off` | Show or hide elapsed time and exact generated token count |
| `/archive [title]` | Save the current session as a readable text file under `archives/`; without a title, use the first user message |
| `/resume <archive-path>` | Restore a previously archived session into the current thread |
| `/clear` | Clear the terminal display |
| `/quit` | Exit ULTRON |

Press Tab after starting a slash command to accept its completion. `/stop` can
also be typed while Nemotron is generating; Ctrl+C remains available as the
immediate interrupt. Archive files are local and ignored by Git.

`/compact`, `/retry`, `/archive` and `/resume <path>` are also available from
the web interface, typed the same way into its message box — see
[Additional entry point — local web interface](PLAN.md) in PLAN.md.

## Repository map

```text
src/core/                            shared engine — knows nothing about any interface
  graph.ts                           LangGraph loop, tool routing, archive/resume
  llm/nemotron.ts                    NVIDIA/Nemotron client
  memory/checkpointer.ts             SQLite checkpoint saver shared by every interface
  memory/chats.ts                    chat registry (list/create/rename/delete) shared by every interface
  tools/                             shell, filesystem, web and process tools
src/interfaces/                      presentation layers — import from core, never the reverse
  cli/index.ts                       terminal interface and streaming
  cli/markdown.ts                    terminal markdown rendering
  web/server.ts                      local web interface (HTTP + SSE streaming)
  web/public/                        web frontend (vanilla HTML/CSS/JS, no framework)
src/config.ts                        shared configuration (env vars, paths)
MEMORY.md                            durable human-readable memory loaded each turn
AGENT.md                             operational rules injected into the prompt
SOUL.md                              personality rules injected into the prompt
PLAN.md                              project roadmap and scope
```

## Roadmap

1. ~~Terminal loop and classic file memory~~ — done.
2. Telegram interface with grammY.
3. Mail and calendar tools with OAuth.
4. Background scheduled tasks once the core loop is trusted.
5. Separate Codex-style vibe-coding application — deferred.

See [PLAN.md](PLAN.md) for the detailed project plan and
[docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) for the original
French research and architecture rationale.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions should preserve the
explicit architecture decisions and keep documentation current with code.

## License

ULTRON is released under the MIT License. See [LICENSE](LICENSE).
