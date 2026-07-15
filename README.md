# ULTRON

Personal AI agent. Built from scratch (not OpenClaw, not Hermes Agent) to keep full control over architecture, permissions, and memory.

## Current state (v0.1)

- Conversation loop in the terminal (Telegram comes later)
- Model: Nemotron (NVIDIA API) via the OpenAI-compatible endpoint
- Persistent memory via LangGraph + Postgres (checkpointing, thread `ultron-main`)
- First tool wired in: `run_shell_command` (see `src/tools/shell.ts`)
- Full visibility into tool activity in the terminal: tool calls and their raw results are printed inline as they happen, not hidden
- Automatic retry with backoff on transient NVIDIA API errors (e.g. mid-stream `ResourceExhausted`) — see `invokeWithRetry` in `src/agent/graph.ts`
- No sandboxing (Docker), no manual per-action confirmation — a deliberate choice by the user

### Known issue — unreliable tool calling

The NVIDIA-hosted Nemotron model does not consistently use proper structured
function-calling when a tool is available. Roughly half the time (observed
empirically) it instead writes a plausible-looking JSON blob as normal reply
text — or fabricates an entire fake tool call *and* fake result, presented as
if it had actually run something. No real command executes in that case; the
"output" is hallucinated. This is not caught or hidden — the visibility work
above makes it show up directly in the terminal so it's obvious when it
happens. Not yet fixed; flagged here as a known limitation of this model on
this endpoint, not a bug in the loop itself.

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
3. Tools (with read / write / destructive scopes)
4. Separate "vibe coding" app, Codex-style, with background sub-agents orchestrated from a main conversation
