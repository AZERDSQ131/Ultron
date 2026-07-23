# ULTRON

ULTRON is a personal AI agent built from scratch with TypeScript, LangGraph,
Nemotron and local files. The goal is simple: keep ownership of the loop, the
state, the memory and the tools instead of hiding them behind an opaque agent
framework.

This repository is public from the beginning. It is an evolving experiment,
not a finished autonomous assistant. The architecture is intentionally small
enough to inspect, change and understand.

## Architecture

ULTRON's process — the LangGraph loop, every tool, and the SQLite database
that holds memory and chat history — is meant to run permanently on one
always-on machine (a home server; the reference deployment is a Jetson Orin
Nano over Tailscale), not on your everyday laptop or phone. Every other
device is a client that talks to that one process, so a conversation looks
the same and shares the same memory no matter which one you're on:

```text
                         ┌──────────────────────────────┐
                         │   Home server (always on)     │
                         │   LangGraph loop · tools ·     │
                         │   SQLite (chats + memory)      │
                         │                                │
                         │  ┌──────────┐   ┌────────────┐ │
                         │  │ web UI   │   │ Telegram   │ │
                         │  │ (HTTP)   │   │ bot (long  │ │
                         │  │          │   │ polling)   │ │
                         │  └──────────┘   └────────────┘ │
                         └───────────────┬────────────────┘
                                         │ Tailscale (HTTP/SSE)
              ┌───────────────┬──────────┼──────────┬───────────────┐
              │               │          │          │               │
       ┌──────▼──────┐ ┌──────▼──────┐ ┌─▼────────┐ ┌▼──────────────┐
       │  Browser     │ │ `ultron` CLI│ │ Telegram │ │  iOS app      │
       │  (any device)│ │(laptop/Mac) │ │(phone)   │ │  (SwiftUI)    │
       └──────────────┘ └─────────────┘ └──────────┘ └───────────────┘
```

Two ways to run the CLI, both `src/interfaces/cli/`:

- **Local** (`index.ts`, `pnpm dev`) — runs the LangGraph loop in-process.
  This is what the home server itself runs, or what you'd use for local
  development. Needs `NVIDIA_API_KEY` and the local database directly.
- **Remote** (`remote.ts`, `pnpm remote`, or the `ultron` bin once linked) —
  a thin network client that talks to a running web server over HTTP/SSE
  instead. This is what a laptop should run: point `ULTRON_SERVER_URL` at
  the home server and `ultron` behaves identically to the local CLI (same
  banner, same prompts, same pickers, same streaming) — it just executes
  the turn over the network instead of in-process, and needs no API key or
  database of its own. The two share every rendering primitive
  (`src/interfaces/cli/ui.ts`) specifically so they stay visually and
  behaviorally identical.

The home server can also reach back out to a Mac over SSH (`host: "mac"` on
the filesystem/shell tools, and `open_app`/`applescript_run` in
`src/core/tools/macos.ts`) to run shell commands, read/write files, or drive
AppleScript-scriptable apps (Notes, Calendar, Reminders, Finder…) there —
useful when the server itself doesn't run macOS but still needs to act on a
Mac. See `src/core/tools/remoteHost.ts` and the `MAC_SSH_HOST` variable
below.

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
- over twenty tools for shell commands, files, HTTP/web requests, processes,
  schedules, macOS automation and the current date/time;
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
ULTRON chat a given Telegram chat points at is auto-linked on first contact
(`TelegramLinkRegistry`) and stays fixed from then on — every chat it
touches is a normal row in `ChatRegistry`, visible (and continuable) from
the mobile app too. There's no true token-by-token streaming (Telegram
rate-limits message edits); a single placeholder message per turn is
updated when the active tool changes and once more with the final text. A
pending tool-approval interrupt (`accept_edit`/`manual` security mode)
renders as one inline-keyboard Approve/Deny for the whole batch, not per
call. `/clear` wipes this conversation's actual message memory
(`clearThreadMessages` in `graph.ts`) in addition to deleting what Telegram
lets a bot delete of its own recent messages (own messages only, ~48h
window) — unlike the CLI/web, where `/clear` only redraws the terminal and
leaves the model's memory of the thread untouched, since there the visible
scrollback is a constant reminder that history persists; Telegram has no
such reminder, so the same "just redraw" behavior read as a memory bug.
`/theme` is an intentional no-op (Telegram's own app controls that).
Replies are converted from ULTRON's Markdown (`**bold**`, `` `code` ``,
`# headers`, `~~strikethrough~~`, links) to Telegram's HTML parse mode
(`src/interfaces/telegram/format.ts`), with a plain-text fallback if a
reply's formatting somehow fails to parse. Requires `TELEGRAM_BOT_TOKEN` in
`.env` (see `.env.example`).

Conversations are organized as chats, each with its own id and title.
**Conversation management — browsing, opening, and continuing any chat,
whether it originated on the CLI or on Telegram — lives exclusively on the
web UI's sidebar and the iOS app** (`ios/`, badges each chat "CLI" or
"Telegram" using a server-computed origin field on `GET /api/chats`). The
local CLI, remote CLI and Telegram bot are deliberately pure chat
terminals: each always continues its own one fixed conversation (the
shared "cli"-scope anchor chat for both CLIs, this Telegram chat's own
linked thread for Telegram) — an ordinary chat like any other, with no
special title or protection from deletion, auto-titled from its first
message the same way — and carries no `/resume`/`/main`/`/delete` commands
of its own anymore — that capability moved entirely to the two interfaces
built for browsing a list.

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

A native iOS app (`ios/`, SwiftUI, iOS 17+, zero external dependency) is a
fourth client, in the same shape as the remote CLI: pure HTTP/SSE against the
web server over Tailscale, no auth beyond that, no bank/database of its own.
Its menu mirrors the web sidebar's chat list (grouped by day, agent-owned
chats excluded, each row badged "CLI" or "Telegram" from a server-computed
`origin` field) plus five modules — Finance, Health, Tokens, Skills, Memory —
each backed by the same REST endpoints the web dashboards already use. It is
now the primary place (alongside the web sidebar) to browse, open and
continue any conversation regardless of which interface it started on — the
CLI and Telegram no longer have their own `/resume`/`/main`/`/delete`
commands. The
conversation screen streams the same SSE turn events (`text`/`tool_call`/
`tool_result`/`approval_required`/`done`) as every other interface, with a
native tool-approval card and a composer bar mirroring the web's model/task-
mode/permission pickers. See `ios/README.md`.

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
| `NEMOTRON_MODEL` | `deepseek-ai/deepseek-v4-flash` | Model identifier |
| `NEMOTRON_BASE_URL` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible endpoint |
| `CONTEXT_WINDOW_TOKENS` | `262144` | CLI context-gauge reference |
| `WEB_PORT` | `4173` | Local web interface port |
| `DATABASE_PATH` | `ultron-state.sqlite3` | Shared checkpoint database (CLI + web) |
| `WEB_SEARCH_PROVIDER` | `auto` | `auto`, `tavily` or `duckduckgo` |
| `TAVILY_API_KEY` | empty | Optional Tavily API key; required when the provider is `tavily` |
| `TELEGRAM_BOT_TOKEN` | empty | Required only to run the Telegram interface |
| `ULTRON_SERVER_URL` | empty | Required only by the remote CLI (`pnpm remote` / the `ultron` bin) — address of the ULTRON web server to connect to |
| `MAC_SSH_HOST` | `mac` | SSH alias (from `~/.ssh/config`, on whichever machine ULTRON's process runs on) used by tools called with `host: "mac"`, and by `open_app`/`applescript_run` whenever ULTRON isn't itself running on macOS |

## Run and verify

```bash
pnpm dev          # run the terminal interface directly from TypeScript (local — runs the graph in-process)
pnpm remote       # run the terminal interface as a network client (needs ULTRON_SERVER_URL, nothing else)
pnpm web          # run the local web interface (http://localhost:4173 by default)
pnpm telegram     # run the Telegram bot (long polling)
pnpm typecheck    # strict TypeScript check
pnpm build        # compile to dist/, including the web frontend assets
pnpm start        # run the compiled local terminal interface
pnpm start:remote # run the compiled remote terminal interface
pnpm start:web    # run the compiled web interface
pnpm start:telegram # run the compiled Telegram bot
```

To get a plain `ultron` command that always connects to a remote server
(what you'd want on a laptop, per the Architecture section above), after
`pnpm build`, symlink the compiled remote client onto your `PATH`, e.g.:

```bash
ln -sf "$(pwd)/dist/interfaces/cli/remote.js" ~/.local/bin/ultron
export ULTRON_SERVER_URL=http://<home-server-tailscale-ip>:4173
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
| `/memory [clear\|forget <id>]` | List, clear, or remove auto-accumulated observations about you (see below) |
| `/quit` | Exit ULTRON |

Press Tab after starting a slash command to accept its completion. `/stop` can
also be typed while Nemotron is generating; Ctrl+C remains available as the
immediate interrupt.

There is no `/resume`, `/main` or `/delete` here (or on Telegram) — the
terminal always continues its one fixed conversation. Browsing, opening and
deleting any conversation is a web UI sidebar / iOS app feature only — see
[PLAN.md](PLAN.md) for interface-specific details.

## Repository map

```text
src/core/                            shared engine — knows nothing about any interface
  graph.ts                           LangGraph loop, tool routing
  llm/nemotron.ts                    NVIDIA/Nemotron client
  memory/checkpointer.ts             SQLite checkpoint saver shared by every interface
  memory/chats.ts                    chat registry — list/create/rename/archive/resume/delete, shared by every interface
  tools/                             shell, filesystem, web and process tools
    search.ts                        DuckDuckGo/Tavily provider abstraction
    remoteHost.ts                    runs a tool's command locally or on the Mac over SSH (host: "mac")
    macos.ts                         open_app/applescript_run — local on macOS, remote over SSH otherwise
src/interfaces/                      presentation layers — import from core, never the reverse
  cli/index.ts                       local terminal interface — runs the graph in-process
  cli/remote.ts                      remote terminal interface — HTTP/SSE client for a ULTRON web server
  cli/ui.ts                          rendering/state shared by index.ts and remote.ts (banner, pickers, streaming display)
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
ios/                                  native iOS app (SwiftUI) — HTTP/SSE client, no backend code
  project.yml                        XcodeGen spec (source of truth for ULTRON.xcodeproj)
  ULTRON/Networking/ULTRONClient.swift  HTTP/SSE client mirroring cli/remote.ts's API usage
  ULTRON/Screens/                    Menu, Chat, Finance, Health, Tokens, Skills, Memory
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
