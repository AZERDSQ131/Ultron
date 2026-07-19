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
- a passive user model: a separate LLM call quietly extracts durable
  preferences/facts/patterns after each turn, without being asked, and feeds
  them back into the prompt to adjust tone and defaults — never merged into
  `MEMORY.md` automatically, reviewable and clearable with `/memory`;
- token streaming, elapsed-time statistics with an exact generated-token count
  (real usage from NVIDIA's endpoint, not an estimate) and an estimated
  context gauge;
- basic terminal Markdown styling, including `**bold**` text;
- local slash commands for stopping, retrying, compacting and tuning reasoning;
- resumable text archives through `/archive` and `/resume`;
- thirteen tools for shell commands, files, HTTP/web requests, processes,
  schedules and the current date/time;
- declared tool scopes (`read`, `write`, `destructive`) for architectural clarity;
- retry handling for transient API errors and malformed plain-text tool calls;
- clean Ctrl+C interruption, including during an in-flight model request.

Web search is available through `web_search` and `fetch_url`. The search
provider is selected with `WEB_SEARCH_PROVIDER=auto` by default: Tavily is
used when `TAVILY_API_KEY` is set, otherwise DuckDuckGo provides a no-key
fallback. Tavily returns ranked snippets and metadata optimized for agent
research; DuckDuckGo keeps the feature usable with zero additional setup.

A local web interface (`pnpm web`) is also available: same LangGraph core,
same streaming and tool-call behavior, served over HTTP with a vanilla
HTML/CSS/JS frontend (native ES modules under `public/js/`, no bundler, no
framework). It shares the same chats and memory as the CLI through a local
SQLite database (`ultron-state.sqlite3`) — a message sent from one interface
shows up in the other, and `/compact`, `/retry` and `/archive` act on the
same history no matter which interface issued them. `GET /api/health` is a
liveness probe (process uptime, model, whether the shared SQLite file is
reachable) — useful for the Telegram process or a supervisor script to check
before assuming ULTRON is up.

A Telegram bot (`pnpm telegram`, grammY, long polling) is a third entry
point: same `buildGraph()`, same shared SQLite file, so a Telegram chat has
the same memory, tools and personality as the CLI and the web UI. Which
ULTRON chat a Telegram chat currently points at is a movable pointer
(`/archive`, `/chat` and `/resume` all repoint it), not a fixed mapping —
every chat it touches is a normal row in `ChatRegistry`, visible from the
web sidebar too. There's no true token-by-token streaming (Telegram
rate-limits message edits); a single placeholder message per turn is
updated when the active tool changes and once more with the final text. A
pending tool-approval interrupt (`accept_edit`/`manual` security mode)
renders as one inline-keyboard Approve/Deny for the whole batch, not per
call. Every CLI local command has a working equivalent — see `/help` inside
the bot for the full list; interactive CLI pickers become inline keyboards,
`/clear` deletes what Telegram lets a bot delete of its own recent messages
(own messages only, ~48h window), and `/theme` is an intentional no-op
(Telegram's own app controls that). Requires `TELEGRAM_BOT_TOKEN` in `.env`
(see `.env.example`).

Conversations are organized as chats, each with its own id and title,
listed in the web UI's sidebar (create, rename, delete, switch between
them). Running `/archive` from the CLI finalizes the current chat and
starts a new one, so the archived chat stays browsable and resumable from
the web sidebar — the CLI itself always resumes whichever chat was most
recently active on either interface.

The web UI also has:

- a command palette (`⌘/Ctrl K`) unifying chat switching, full-text search
  across every chat's messages, and slash commands behind one keyboard-first
  entry point;
- message actions on hover — copy, toggle raw markdown, and (on the last
  turn of each role only, matching what the backend can actually undo) edit
  the last message or regenerate the last reply;
- tool-call blocks badged by declared scope (read/write/destructive) so a
  destructive call reads as such at a glance without opening it;
- a settings/shortcuts panel (`⌘,` / `⌘/`) with a manual light/dark theme
  toggle (system-aware by default), the reasoning mode, verbose stats, and
  the live tool list with its scopes;
- a small set of global keyboard shortcuts (new chat, search, settings,
  toggle sidebar…) — the full list is in the Shortcuts tab of that panel.

Mail and calendar integrations are still pending because they require OAuth.
The separate Codex-style coding app is explicitly deferred.

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
| `NEMOTRON_MODEL` | `z-ai/glm-5.2` | Model identifier |
| `NEMOTRON_BASE_URL` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible endpoint |
| `CONTEXT_WINDOW_TOKENS` | `262144` | CLI context-gauge reference |
| `WEB_PORT` | `4173` | Local web interface port |
| `DATABASE_PATH` | `ultron-state.sqlite3` | Shared checkpoint database (CLI + web) |
| `WEB_SEARCH_PROVIDER` | `auto` | `auto`, `tavily` or `duckduckgo` |
| `TAVILY_API_KEY` | empty | Optional Tavily API key; required when the provider is `tavily` |
| `TELEGRAM_BOT_TOKEN` | empty | Required only to run the Telegram interface |

## Run and verify

```bash
pnpm dev          # run the terminal interface directly from TypeScript
pnpm web          # run the local web interface (http://localhost:4173 by default)
pnpm telegram     # run the Telegram bot (long polling)
pnpm typecheck    # strict TypeScript check
pnpm build        # compile to dist/, including the web frontend assets
pnpm start        # run the compiled terminal interface
pnpm start:web    # run the compiled web interface
pnpm start:telegram # run the compiled Telegram bot
```

There are currently no automated tests or lint script. The first tests should
cover graph routing, retry and fake-tool-call handling, tool behavior,
interruption, web search providers and classic file memory.

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
| `/verbose on\|off` | Show or hide the per-turn stats line (model, input/output tokens, elapsed time, estimated cost) |
| `/archive [title]` | Save the current session as a readable text file under `archives/`; without a title, use the first user message |
| `/resume <archive-path>` | Restore a previously archived session into the current thread |
| `/memory [clear\|forget <id>]` | List, clear, or remove auto-accumulated observations about you (see below) |
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
    search.ts                        DuckDuckGo/Tavily provider abstraction
src/interfaces/                      presentation layers — import from core, never the reverse
  cli/index.ts                       terminal interface and streaming
  cli/markdown.ts                    terminal markdown rendering
  web/server.ts                      local web interface (HTTP + SSE streaming)
  web/public/                        web frontend (vanilla HTML/CSS + native ES modules, no framework)
    style.css                        design tokens (light/dark) and every component's styles
    index.html                       shell: sidebar, thread, composer, command palette, inspector
    js/main.js                       entry point — wires every module together and boots the app
    js/thread.js                     message rendering, tool-call blocks, per-turn actions
    js/composer.js                   input, streaming, slash commands, edit/regenerate
    js/palette.js                    ⌘/Ctrl K command palette (chats + search + commands)
    js/inspector.js                  settings/shortcuts slide-over panel
    js/chatList.js                   sidebar (list/create/rename/delete/select)
    js/theme.js                      light/dark/system theme preference
    js/api.js                        fetch wrappers for every backend route
    js/store.js                      shared app state
    js/markdown.js                   the same lightweight Markdown renderer as the CLI
  telegram/index.ts                  Telegram bot (grammY, long polling)
src/config.ts                        shared configuration (env vars, paths)
MEMORY.md                            durable human-readable memory loaded each turn
AGENT.md                             operational rules injected into the prompt
SOUL.md                              personality rules injected into the prompt
PLAN.md                              project roadmap and scope
```

## Roadmap

1. ~~Terminal loop and classic file memory~~ — done.
2. ~~Telegram interface with grammY~~ — done.
3. Mail and calendar tools with OAuth.
4. ~~Background scheduled tasks once the core loop is trusted~~ — web foundation started: Agents, Agent-owned chats, persisted five-field cron schedules and scheduled execution chats are available in the web interface. Schedules are created conversationally through ULTRON's `schedule_task` tool.
5. Separate Codex-style vibe-coding application — deferred.

See [PLAN.md](PLAN.md) for the detailed project plan and
[docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) for the original
French research and architecture rationale.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions should preserve the
explicit architecture decisions and keep documentation current with code.

## License

ULTRON is released under the MIT License. See [LICENSE](LICENSE).
