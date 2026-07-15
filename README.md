# ULTRON

Personal AI agent. Built from scratch (not OpenClaw, not Hermes Agent) to keep full control over architecture, permissions, and memory.

## Current state (v0.1)

- Conversation loop in the terminal (Telegram comes later)
- Model: Nemotron (NVIDIA API) via the OpenAI-compatible endpoint
- Persistent memory via LangGraph + Postgres (checkpointing, thread `ultron-main`)
- Eleven tools wired in, `src/tools/`: `run_shell_command`, `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `fetch_url`, `http_request`, `web_search`, `list_processes`, `kill_process` — registered with declared scopes (read / write / destructive) in `src/tools/index.ts`. The web/process tools are modeled on [OpenClaw](https://github.com/openclaw/openclaw)'s own tool categories (`exec`, `web_search`, `web_fetch`, `process`), read directly from its GitHub docs rather than installed.
- System prompt is split across two files: [SOUL.md](SOUL.md) (personality only) and [AGENT.md](AGENT.md) (tool-use protocol and every other operational rule) — see the note at the top of each
- Full visibility into tool activity in the terminal: tool calls and their raw results are printed inline as they happen, not hidden
- Unified retry loop (transient API errors + fake tool calls share one budget, max 4 attempts) — see the `agent` node in `src/agent/graph.ts`. Only the first attempt streams live; retries run with callbacks stripped so a retried response can never print a duplicate of text already shown (this actually happened: a retried "Salut !" reply reused a SOUL.md example verbatim and printed twice before the fix).
- Guardrail against fake tool calls (see below) — see `looksLikeFakeToolCall` / `sanitizeHistory` in `src/agent/graph.ts`
- No sandboxing (Docker), no manual per-action confirmation — a deliberate choice by the user

### Known issue — unreliable tool calling (mitigated)

Nemotron itself supports real structured tool-calling fine — confirmed
empirically at 100% reliability on isolated, single-turn calls, with or
without streaming, with or without the full system prompt. The problem only
shows up in the long-running, persistent `ultron-main` thread: once the
model writes a tool call as plain JSON text instead of a real `tool_calls`
entry, that fake exchange used to get saved to history, and the model would
imitate its own past bad behavior on later turns — a self-reinforcing loop.

Mitigated in `src/agent/graph.ts`:
- `looksLikeFakeToolCall` detects a plain-text reply shaped like a real
  tool's arguments (derived from each tool's own zod schema, so it
  generalizes to new tools).
- On detection, the turn is silently retried (sharing the same 4-attempt
  budget as transient-error retries — see above) rather than accepted.
- `sanitizeHistory` strips any such fake messages already sitting in
  persisted history out of the prompt on every turn, so old pollution can't
  keep re-poisoning new generations.
- If every retry still fails, ULTRON returns an explicit failure notice
  instead of ever presenting a fabricated tool result as fact.

Verified end to end against the real, already-polluted `ultron-main`
thread: real tool calls now go through reliably (occasionally after one
internal retry, invisible to the conversation content, logged to stderr).

## Setup

```bash
pnpm install
cp .env.example .env   # fill in NVIDIA_API_KEY
pnpm dev
```

Requires a local Postgres instance running with an `ultron` database (already created via `createdb ultron`).

## Stopping the agent

`Ctrl+C` at any time, including mid-response — the in-flight request is cancelled cleanly.

## Documentation

See [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) (French) for the full research and architecture decisions behind this project (AI model landscape, OpenClaw/Hermes comparison, pitfalls to avoid, chosen stack).

## Roadmap

1. ~~Loop + memory~~ (done)
2. Telegram interface (replaces/complements the terminal)
3. Tools (with read / write / destructive scopes) — filesystem, shell, web, and process tools done; mail/calendar still to come, they need OAuth setup
4. Separate "vibe coding" app, Codex-style, with background sub-agents orchestrated from a main conversation
