# ULTRON

Personal AI agent. Built from scratch (not OpenClaw, not Hermes Agent) to keep full control over architecture, permissions, and memory.

## Current state (v0.1)

- Conversation loop in the terminal (Telegram comes later)
- Model: Nemotron (NVIDIA API) via the OpenAI-compatible endpoint
- Persistent memory via LangGraph + Postgres (checkpointing, thread `ultron-main`)
- No tools wired in yet — loop and memory only
- No sandboxing (Docker), no manual per-action confirmation — a deliberate choice by the user

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
