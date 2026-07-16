# ULTRON Durable Memory

This file is ULTRON's long-term, human-readable memory. It is loaded into the
system prompt on every turn and is shared by the CLI and web interfaces.

## How to use this memory

- Read this file before answering and use it when it is relevant to the user's
  request.
- Treat only explicit, confirmed information as fact. Never turn a guess,
  filesystem username, tool output, or inference into a personal fact.
- When the user explicitly gives a durable fact or preference, update this file
  with the filesystem tools (`edit_file` or `write_file`) so it survives future
  conversations.
- Update an existing entry instead of creating a duplicate. Remove or correct
  an entry when the user says it is outdated or wrong.
- Keep entries concise, factual, and organized under the appropriate section.
- Do not store passwords, API keys, tokens, private credentials, or sensitive
  temporary details.
- Do not record a person's name, identity, preferences, or personal details
  unless the person has stated or confirmed them directly.
- If two entries conflict, do not silently choose one: ask the user which one
  is correct, then keep only the confirmed version.

## User profile

- Name: Jules
- Preferred response language: French
- Other durable preferences: Favorite fruit: mango.

## ULTRON project

- ULTRON is developed directly in its repository without coding sub-agents.
- The model is Nemotron through NVIDIA's API exclusively for now.
- The shared orchestrator is LangGraph.js.
- Persistent chat state and chat registry use the local SQLite database
  `ultron-state.sqlite3` through the hand-written `SqliteSaver` and
  `ChatRegistry`.
- The terminal CLI and local web interface share the same core, chats, and
  memory system.

## Confirmed decisions

- Security remains intentionally minimal: no Docker sandbox and no manual
  confirmation gates unless the user explicitly changes this decision.
- Mail and calendar integrations are not implemented yet because OAuth is
  still pending.

## Temporary context

Nothing currently needs to be carried temporarily across conversations.