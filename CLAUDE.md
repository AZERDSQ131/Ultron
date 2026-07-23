# CLAUDE.md — ULTRON

Instructions for any Claude Code session working on this repo.

## Project context

ULTRON is a personal AI agent built from scratch by the user, replacing OpenClaw and Hermes Agent. Reason for the switch: loss of control felt with those frameworks (see documented case where an OpenClaw agent deleted hundreds of emails despite being instructed to wait for approval — no technical checkpoint blocked the action).

The full research context (latest AI models, OpenClaw vs Hermes Agent comparison, security/architecture pitfalls to avoid, personal-life use case ideas) lives in [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) — written in French, kept as-is as a historical research artifact. Read it before any architecture decision that departs from the original plan.

## Architecture decisions already made

- **Model**: NVIDIA API (Nemotron and other NVIDIA-hosted models, e.g. vision models for photo analysis) is the default provider. DeepSeek and Groq (both OpenAI-compatible, not NVIDIA-hosted) are wired up as two additional API-key providers, and OpenAI is a fourth provider authenticated differently (see the OAuth paragraph below). `/provider [nvidia|deepseek|groq|openai]` (CLI, web, Telegram) cycles nvidia→deepseek→groq→openai→nvidia when called bare, skipping any provider without credentials (`nextConfiguredProvider`, `src/config.ts` — for openai this means "not logged in" rather than "no API key"), or switches directly with an explicit argument. `/model` shows **all four providers' catalogs at once**, grouped under a header per provider (NVIDIA's live `/v1/models` catalog, DeepSeek's two fixed models `deepseek-v4-flash`/`deepseek-v4-pro`, Groq's live `/openai/v1/models` catalog filtered to active text-output models that declare `tools` support in `supported_features` — Groq's list also includes TTS/vision/safety-only models ULTRON's tool-calling loop can't use — and OpenAI's live `/backend-api/codex/models` catalog once logged in, empty otherwise) — picking a model from a different provider than the active one switches both in one step. `config.provider` (`LlmProvider`, `src/config.ts`) holds the active provider; each provider remembers its own last-picked model (`providerModels`, private to `config.ts`) so switching back and forth restores rather than resets. `setActiveProvider`/`setActiveModel` (`src/config.ts`) are the only mutators — every interface routes model/provider switches through them instead of assigning `config.nemotronModel` directly, so the per-provider stash never drifts out of sync. `src/core/llm/models.ts` exports `listAvailableModels` (active provider only — used for the initial context-window lookup at startup and right after a provider switch), `listModelsByProvider` (all four, grouped — what `/model` actually shows), and `resolveModelContext` (generic over `ModelInfo`, enriches a single NVIDIA model's context length lazily by scraping its `build.nvidia.com` model card since NVIDIA's own `/v1/models` often omits it — a no-op for DeepSeek/Groq/OpenAI, which already state context length directly in their listing). Shared by the local CLI, the web server's `/api/models`, `/api/models/grouped` and `/api/provider` (which the remote CLI and Telegram's `/model` both go through), and Telegram's own model picker. `visionModel` (photo analysis) always stays on NVIDIA regardless of `config.provider` — none of the other three providers has a vision equivalent wired up. `nvidiaApiKey` stays `required()` unconditionally for that reason; `deepseekApiKey`/`groqApiKey` are only validated lazily (`createNemotronModel`, `src/core/llm/nemotron.ts`) when that provider is actually selected. Neither DeepSeek's, Groq's nor OpenAI's API has an equivalent to NVIDIA NIM's `chat_template_kwargs` reasoning knob, so `thinkingMode` is a no-op on those three providers for now.
- **OpenAI provider — ChatGPT device-code OAuth, not an API key** (`src/core/llm/openaiAuth.ts`, `src/core/memory/openaiAuth.ts`): unlike the other three, "openai" authenticates by signing in with a ChatGPT Plus/Pro/Team account and using its included model quota (the GPT-5.6 family), the same mechanism OpenAI's own open-source `codex` CLI uses — verified directly against `openai/codex`'s Rust source (`codex-rs/login/src`), not assumed from docs. Device-code flow (works headless — the right fit since ULTRON's server may run on the Jetson while the user approves from their phone/Mac): `POST https://auth.openai.com/api/accounts/deviceauth/usercode` gets a `user_code` + verification URL (`https://auth.openai.com/codex/device`) to show the user; polling `POST .../deviceauth/token` until approved yields an authorization code + PKCE pair, exchanged at `POST https://auth.openai.com/oauth/token` for `{id_token, access_token, refresh_token}`. `client_id` is the public, non-secret PKCE client id Codex CLI itself uses (`app_EMoamEEZ73f0CkXaXp7hrann` — safe to hardcode, no client_secret exists for a PKCE public client). `OpenAIAuthRegistry` (`src/core/memory/openaiAuth.ts`) persists the token set globally (one row, like `UserModelRegistry` — one ULTRON install, one ChatGPT login), plaintext per the project's already-documented minimal-security posture. `getValidAccessToken` (`src/core/llm/openaiAuth.ts`) decodes the access token's JWT `exp` claim and refreshes proactively ~60s before expiry — the one function every other piece calls. Every Codex backend request also needs a `ChatGPT-Account-ID` header alongside the bearer token, or the backend replies `400` — found live (first real `/login openai` + `/provider openai` run against a real account returned "ChatGPT Codex backend returned HTTP 400") and confirmed against `openai/codex`'s `model-provider/src/auth.rs` (`BearerAuthProvider`/`AgentIdentityAuthProvider` both set this header from the account id, and `chatgpt_client.rs`'s own request builder asserts an account id is present before sending). The account id lives in the id_token JWT's `https://api.openai.com/auth.chatgpt_account_id` claim — `decodeAccountId` extracts it, `getValidAuth` returns `{accessToken, accountId}` together (falling back to decoding it from the already-stored id_token when the cached token is still valid, so accounts that logged in before this fix don't need to re-run `/login openai`), and `codexAuthHeaders(accessToken, accountId)` builds the actual header set (`Authorization` + `ChatGPT-Account-ID` + `OAI-Product-Sku: codex`, the last one also required by `chatgpt_client.rs`) — used by both `models.ts`'s `fetchOpenAIModels` and `nemotron.ts`'s `openaiOAuthFetch` override. The `/models` endpoint specifically also 400s without a `?client_version=` query param (`CODEX_CLIENT_VERSION`, pinned to the currently-published `@openai/codex` npm version — the Responses endpoint used for actual chat calls doesn't need it) and returns a different shape than NVIDIA/Groq's OpenAI-compatible `/models` (`{models: [{slug, context_window, ...}]}`, not `{data: [{id}]}` — `fetchOpenAIModels` reads `slug` as the model id). Model calls go through `https://chatgpt.com/backend-api/codex` using OpenAI's *Responses* API shape (not chat-completions) — `@langchain/openai@0.4.9`'s `ChatOpenAI` supports this directly via `useResponsesApi: true`, so no custom HTTP client was needed. That endpoint also rejects any request without `store: false` (confirmed live: `{"detail":"Store must be set to false"}` — the Codex CLI never asks the backend to retain responses server-side since it keeps conversation state locally, same as ULTRON's own checkpointer) — set via `modelKwargs: { store: false }`, since `ChatOpenAI`'s Responses-API `invocationParams` doesn't expose a first-class `store` option and `modelKwargs` is the one place that gets spread into the final request body regardless. Crucially, `createNemotronModel` (`src/core/llm/nemotron.ts`) stays fully **synchronous** despite token refresh being an async network call: instead of awaiting a fresh token at model-construction time (which would force `buildGraph()` and every one of its many call sites — CLI, web, Telegram, every cheap separate call in `goalJudge.ts`/`userModelExtractor.ts`/`chatTitler.ts`/`narrator.ts` — to become async too), the `openai` branch passes a custom `configuration.fetch` override that resolves/refreshes the token right before each actual HTTP request, deferring the only genuinely async step to a point that was already async (`.invoke()`/`.stream()`). Login UX exists on all four interfaces via shared server endpoints (`POST /api/openai/login/start` → `{loginId, verificationUrl, userCode}`, server polls the device-code flow in the background — same start/background-loop/status shape already used for `spawn_agent`'s background runs, `src/core/runs.ts` — `GET /api/openai/login/status?loginId=` for the client to poll, `GET /api/openai/status` for a connected/email indicator, `POST /api/openai/logout` to revoke): `/login openai` on local/remote CLI and Telegram, the web command palette's `/login openai`, and `OpenAILoginSheet.swift` on mobile (shown from the model picker's empty "OPENAI" group). A login is global, not per-chat/per-interface — connecting from any one of the four makes `openai` available everywhere.
- **Orchestrator**: LangGraph.js — the user owns the loop and the state, not a black-box framework.
- **Memory**: local SQLite checkpoint database (`ultron-state.sqlite3`), custom `SqliteSaver` in `src/core/memory/checkpointer.ts` implementing LangGraph's `BaseCheckpointSaver` directly on Node's built-in `node:sqlite` (no `@langchain/langgraph-checkpoint-postgres`/`pg`, no `@langchain/langgraph-checkpoint-sqlite` — neither package's published versions match this project's `@langchain/core` ^0.3 / `langgraph` ^0.2 pin, and `node:sqlite` needs zero extra dependencies since Node 24 is already required).
- **Chats**: conversations are no longer a single hardcoded thread. `src/core/memory/chats.ts` (`ChatRegistry`) tracks every chat (id, title, timestamps) in the same database file; a chat's `id` doubles as its LangGraph `thread_id`. The web UI's sidebar lists/creates/renames/deletes chats. The CLI keeps one "current chat" per process, resuming whichever chat was most recently active on either interface at startup; `/archive` finalizes the current chat and starts a fresh one rather than exiting. The legacy hardcoded thread id (`ultron-main`, exported as `LEGACY_CHAT_ID`) is migrated into the registry on first run via `chats.ensure(...)` so pre-existing history isn't orphaned.
- **Interface**: terminal (v0.1), a local web UI (`src/interfaces/web/`), a Telegram bot (`src/interfaces/telegram/`, grammY, long polling — `pnpm telegram`/`start:telegram`), and a native iOS app (`ios/`) — all four point at the same SQLite file, so they share memory, tools and personality. **Conversation management (`/resume`, `/main`, `/delete`) was removed from the local CLI, remote CLI, and Telegram** (explicit request, following a report that the mobile app posting to a Telegram-linked chat produced a confusing "🖥️ CLI › ..." echo — the deeper reason was that `ChatEventSource` only has two values, `"cli"`/`"telegram"`, and any HTTP client that doesn't send an explicit `source` — the browser, the remote CLI, and now the mobile app — silently gets bucketed as `"cli"`). Those three interfaces are now pure chat terminals on one fixed conversation each: local/remote CLI always resume the shared `CLI_CHAT_SCOPE` anchor chat (`chats.activateMain(CLI_CHAT_SCOPE)` at startup, never moved by a command again), Telegram always continues whatever chat is linked to that specific Telegram chat (`currentChatId()`, `telegram/index.ts` — auto-created/linked on first contact, independent of any command, see `TelegramLinkRegistry`, `src/core/memory/telegramLinks.ts`). **There is no more special "Main" chat**: a report that deleting the CLI's anchor chat from the mobile app made it reappear instantly traced back to `ChatRegistry.delete()` unconditionally recreating and re-adopting a fresh chat titled `"Main"` whenever the deleted id was a scope's current anchor — removed entirely. `delete()` is now a plain, unconditional row delete with no special-casing and no `scope` parameter; a scope's anchor is created lazily (by `getMain`) only the next time that scope actually needs one (e.g. the CLI starting up), never as an instantaneous side effect of a delete call elsewhere. `activateMain`'s forced rename to the literal string `"Main"` is gone too — every chat, including a CLI/Telegram anchor, starts as an ordinary `DEFAULT_CHAT_TITLE` ("New chat") row. **Real per-chat title generation** (`src/core/chatTitler.ts`, `autoTitleChat`): on a chat's first human message, an instant deterministic placeholder (`deriveTitle`'s truncation, same as before) is set synchronously, then a separate cheap LLM call (`generateChatTitle`, `createNemotronModel("low")`, same fire-and-forget pattern as `judgeGoal`/`recordUserModelObservation`, logged under the `"chat_title"` usage kind) produces a real short title and overwrites the placeholder once it resolves — never blocking the turn, never clobbering a title the user already changed, silently falling back to the placeholder on any failure (rate limits, API errors). **The mobile app (`ios/`) is now the only place to browse, open, and continue every conversation** (from either CLI or Telegram origin) — it lists every non-agent-owned chat via `GET /api/chats` (unchanged, was already unfiltered by scope) and just posts turns directly against a chat's id, no relinking API needed since `chat_id` already *is* the shared LangGraph `thread_id`. To label each row, `GET /api/chats` attaches a computed `origin: "cli" | "telegram" | "app"` field per chat (`ChatRegistry.getOrigin`, made public) — rendered as a small badge in `ChatListRow.swift`. A brand-new mobile-created chat used to show up mislabeled "CLI" because `getOrigin` originally only ever inferred origin from a chat's *message history* (`chat_events.source`, itself only `"cli"`/`"telegram"`) — a freshly created, still-empty chat has no such history to infer from, so it silently fell through to the "CLI" default. Fixed by stamping origin once at creation time instead of inferring it after the fact: `chats.created_via` (a new column, distinct from `chat_events.source` — one tags who *made* the conversation, the other tags who sent each *message*) is set by `create()`/`ensure()` and read first by `getOrigin`, falling back to the old history-based guess only for chats that predate the column. `POST /api/chats` accepts an `origin` field (`"app"`/`"telegram"`/defaults to `"cli"`) for this; the mobile app is the only caller that sends `"app"` today. The web UI's own sidebar/archive panel is untouched and keeps its full `/api/chats/:id/archive`, `/api/chats/:id/resume`, `/api/chats/archived`, `POST /api/main` routes exactly as before — only the CLI/Telegram *commands* that drove those flows disappeared, not the underlying web-facing routes. `handleTurn` (`server.ts`) no longer calls `chats.setFocus(chatId, CLI_CHAT_SCOPE)` on every HTTP turn — that call existed solely to feed the remote CLI's now-removed live "follow the other interface" poll (`syncFocusedChat`, deleted along with `GET /api/focus`/`handleChatFocus`, both now fully unused); without it, a mobile client freely opening an old conversation no longer silently hijacks which chat the terminal CLI is anchored to. **Known limitation, accepted as-is**: since `ChatEventSource` stays two-valued by explicit choice, the local CLI still can't tell "my own turn" apart from "a turn the mobile app just sent on this same chat" — a message sent from mobile into the CLI's anchor conversation won't appear live in an already-open terminal (it's there on the next history reload; the SQLite-backed memory itself is never lost). Telegram's `/clear` deliberately still wipes the thread's actual message state (`clearThreadMessages` in `graph.ts`), unlike the CLI/web's terminal-only `/clear` — Telegram has no visible scrollback reminding the user that history persists, so "just redraw" reads as a memory bug there (confirmed by a real report). Replies are converted from Markdown to Telegram's HTML parse mode (`src/interfaces/telegram/format.ts`). Archiving is a metadata flag on the `chats` row (`ChatRegistry.archive`/`unarchive`/`listArchived`, `src/core/memory/chats.ts`), not a data export — the chat's LangGraph checkpoint is untouched either way, so reopening it (web's own resume, or the mobile app opening any chat) gets full context back (tool calls included), not a lossy text reconstruction.
- **Language**: the project itself (code, comments, console labels, docs) is in English. ULTRON's conversational replies match whatever language the user is currently writing in (French in → French out, English in → English out) — this is enforced in [AGENT.md](AGENT.md). Do not let it default to English regardless of input language.
- **System prompt split**: [SOUL.md](SOUL.md) is personality only (voice, tone, examples). [AGENT.md](AGENT.md) is everything else — tool-use protocol, language matching, other operational rules. Don't fold one into the other; `src/core/graph.ts` concatenates both at startup.
- **Security intentionally minimal**: the user explicitly asked for **no Docker, no hardened secret management, full bypass of manual permissions/confirmations**. This is NOT an oversight — do not reintroduce sandboxing or confirmation gates without an explicit request.
- **Logs**: explicitly not required by the user for now. Do not add a logging/audit system without being asked.
- **Stop**: Ctrl+C must interrupt the loop at any time, including mid LLM call (AbortController).
- **No sub-agents for coding this project**: the user explicitly asked not to use the Agent/sub-agent tool to develop ULTRON. Work directly.
- **Docs stay current**: update PLAN.md / README.md / CLAUDE.md whenever a change makes them stale (new tool, new phase started, a decision changes) — don't let them drift from the actual code state.
- **Deployment target**: ULTRON's process (web server + Telegram bot + database) is meant to live permanently on a Jetson Orin Nano, reachable over Tailscale — not on the Mac. See PLAN.md's "Jetson deployment + Mac access" for current status (repo deployed at `~/ultron` on the Jetson, systemd units prepared but not enabled, Mac SSH access blocked on a one-time Tailscale SSH check only the user can complete).
- **Remote CLI**: `src/interfaces/cli/remote.ts` (`pnpm remote` / `start:remote` / the `ultron` bin) is a *separate* entry point from the local CLI (`src/interfaces/cli/index.ts`) — it never imports `config.js`/`graph.js` as values (only `import type`, erased at compile time), talks to a ULTRON web server purely over HTTP/SSE (`ULTRON_SERVER_URL`), and is what should run on the Mac. Both entry points share every terminal-rendering primitive via `src/interfaces/cli/ui.ts` (banner, raw-mode input loop, pickers, tool-approval prompt, context bar, skill-mention autocomplete) — verified byte-for-byte identical output for the same script (pseudo-tty test) — so they're genuinely the same interface with two different data sources, not two implementations that happen to look similar. `ui.ts` itself must stay backend-agnostic: never import `config.js`/`graph.js`/`chats.js`/etc. as values, only as `import type`, and parameterize anything that would otherwise read them directly (e.g. `printBanner(modelName)`, `showRestoredMessages(messages, modelName)`) — that's what lets a machine running only `remote.ts` need nothing but `ULTRON_SERVER_URL`.
- **Mac access from tools**: `run_shell_command`/`read_file`/`write_file`/`edit_file`/`list_directory`/`search_files` take an optional `host: "jetson" | "mac"` (default `jetson` — the machine ULTRON's own process runs on, not literally required to be a Jetson). `host: "mac"` routes through `src/core/tools/remoteHost.ts`'s `runOnHost`, which shells out via `ssh $MAC_SSH_HOST` (default alias `mac`, must already exist with key auth in that machine's `~/.ssh/config`). `open_app`/`applescript_run` (`macos.ts`) don't take a `host` param — they branch on `process.platform` instead, since they only ever mean "do this on a Mac" regardless of where ULTRON's process happens to run.
- **Health module** (all 6 planned phases done except calendar correlation, which is genuinely blocked — no calendar/OAuth integration exists anywhere in this codebase yet): `src/core/memory/health.ts` (`HealthRegistry`, global like `UserModelRegistry`) stores daily health-export data (activity/sleep/heart from a Health Export Kit-style JSON payload) in `health_days` — full raw payload kept forever, never purged, plus flat extracted metrics for fast range queries — with `health_baselines` (7/30/90-day rolling mean/stddev per metric) and `health_profile` (birthdate, sleep target). Ingestion is primarily `POST /api/health-data/ingest` on the web server (`src/interfaces/web/server.ts`), the only route on that server requiring auth (`x-health-token` header checked against `config.healthIngestToken`/`HEALTH_INGEST_TOKEN`) since it's meant to be called directly by an external export app/shortcut, not the browser UI — disabled entirely if the token isn't set. `health_ingest`/`health_set_profile` (`src/core/tools/health.ts`) are manual/conversational fallbacks; `health_query` answers date-range/aggregate/score questions without needing the raw JSON in context. `src/core/health/scoring.ts` (`computeRecoveryScore`/`computeActivityScore`, personal 30-day-baseline z-scores) and `trends.ts` (`detectAnomalies`, including a composite illness/overtraining flag) are pure, deterministic — never LLM-computed. `bioAge.ts` (`estimateBiologicalAge`) is an explicitly non-clinical, fully explained wellness estimate. `narrator.ts` (`narrateHealth`, same cheap-separate-LLM-call pattern as `userModelExtractor.ts`/`goalJudge.ts`, fed only computed numbers) backs the on-demand-only `health_report` tool (never auto-pushed by default — the user explicitly didn't want that; `schedule_task` covers it if ever wanted) and `export.ts`/`health_export` covers a one-shot Markdown dump. A deterministic (no LLM) `<health_recent>` block in `buildSystemPrompt` (`graph.ts`) summarizes the last 7 days plus today's scores/anomaly/streak, excluded from sub-agent prompts the same way `<user_model>` already is. `/health` (CLI and Telegram) shows the same summary with an ASCII sparkline (`sparkline()` in `health.ts`). `public/js/healthView.js` is a native-SVG dashboard view folded into the main app shell (swapped in for `#thread`/footer, not a separate page — see the 2026-07-20 web redesign note below), backed by `GET /api/health-data/summary`. `gatherHealthContext()` in `goalJudge.ts` feeds `/task goal`'s judge (CLI and web) the last 7 days of data alongside any code diff. All health data lives in the same SQLite file as everything else, so it only ever exists wherever that file lives (the Jetson) — retention is intentionally unlimited, no TTL/purge job.
- **Usage tracking**: `src/core/memory/usage.ts` (`UsageRegistry`, `usage_log` table, global, never purged) logs every LLM call ULTRON makes — not just main chat turns but every cheap separate call too (`narrator.ts`'s two functions, `goalJudge.ts`, `userModelExtractor.ts`, `visionAnalyzer.ts`) — via `recordUsage()` in `src/core/llm/usage.ts`, called at each of those call sites right where real token usage (`response.usage_metadata`) is already available, tagged with a `kind` (`chat`/`narrator`/`goal_judge`/`user_model`/`vision`) and the active `config.provider`/model at call time. `recordUsage` takes an explicit provider override for `visionAnalyzer.ts` specifically, since vision always runs on NVIDIA regardless of `config.provider`. Never throws — a broken usage write must not break the actual reply. The three main-turn call sites (CLI's `executeTurn`, web's `streamGraphTurn`, Telegram's `runSingleTurn`) now compute `inputTokens`/`generatedTokens` unconditionally instead of only when `/verbose` is on, so usage is tracked regardless of that display setting. `GET /api/usage/summary?days=N` (`N=0` for all-time) backs the web UI's "Tokens" view (`public/js/usageView.js`, `/tokens` command, sidebar button below Health). No CLI/Telegram surface for this yet, only web.
- **Finance module** (manual entry only, deliberately optimized for "just say it in chat" — bank sync was explicitly scoped out: a real DSP2/Enable Banking connector needs a developer Application ID, an RSA keypair, and a public OAuth redirect URI the Jetson doesn't have, too much setup per the user): `src/core/memory/finance.ts` (`FinanceRegistry`, global, never purged) stores `finance_accounts` (name/type/currency), `finance_balance_snapshots` (one upserted row per account per calendar day), and `finance_transactions` (signed amount, free-text category), plus analytics read paths — `getSpendingByCategory`, `getMonthlyCashFlow`, `currentMonthSummary` — computed on read, not stored. `getOrCreateAccount` (used by every write path, `DEFAULT_ACCOUNT_NAME = "Principal"` when the user names no account) is what makes logging a balance or transaction never require a separate "create account" step first — the opposite tradeoff from `findAccountByName`'s exact-match-only lookup elsewhere, which stays strict for reads/deletes so the model can't silently write to the wrong account once more than one exists. `getNetWorthHistory` forward-fills each account's last known balance across the requested range so a freshly-added account with no history doesn't make earlier days look like net worth dropped. `finance_add_account`/`finance_record_balance`/`finance_add_transaction`/`finance_query` (`src/core/tools/finance.ts`) are the conversational surface — `finance_record_balance`/`finance_add_transaction` are written to be called proactively (same pattern as `log_meal_or_exercise`: "call this whenever the user mentions...", not just when explicitly asked), with the model guessing a transaction's category itself. `GET /api/finance/summary?days=N` (accounts, net worth history, this-month summary, spending by category, 6-month cash flow, recent transactions) + `POST/DELETE /api/finance/accounts[/:id]` + `POST /api/finance/accounts/:id/{balance,transactions}` back the web UI's "Finance" view (`public/js/financeView.js`, `/finance` command, sidebar button below Tokens) — inline forms directly in the account cards (no modal), primarily a read dashboard (net worth trend, income vs. expenses chart, category breakdown) since chat is the primary way of logging anything now. `public/js/viewSwitcher.js` (`closeOtherViews`) is the shared registry the three swapped-in views (Health/Tokens/Finance) use to stay mutually exclusive — added when Finance made the previous pairwise "each view reaches into the next view's DOM directly" pattern from `healthView.js`/`usageView.js` not scale past two. No CLI/Telegram surface for this yet, only web.

## Known roadmap (do not build ahead of a request)

1. Loop + memory (current stage, done)
2. Telegram interface (done — `src/interfaces/telegram/`)
3. Tools with scopes (read / write / destructive) — even with manual confirmations disabled by choice, keep scopes declared in code for clarity. In progress: shell + filesystem tools done (`src/core/tools/`), mail/calendar still pending (need OAuth).
4. Separate "Codex-style" app for vibe coding, with a main conversation orchestrating background sub-agents to manage projects. Do not start this without an explicit request — it was deliberately deferred during initial design.

## Stack

TypeScript (Node 24+) / pnpm / LangGraph.js / SQLite (`node:sqlite`, no external database) / `@langchain/openai` (OpenAI-compatible client pointed at the NVIDIA API).

## Git conventions

- `main`: stable
- `develop`: current work
- Commit + push on every code change (explicit user request — do not batch multiple changes into one deferred commit).

---

# État opérationnel du dépôt

## Vue d'ensemble

ULTRON est un agent IA personnel développé directement par l'utilisateur pour
conserver la maîtrise de la boucle d'exécution, des outils et de la mémoire.
La version actuelle fournit plusieurs conversations persistantes, accessibles
depuis trois interfaces qui partagent le même état : le terminal
(`src/interfaces/cli/index.ts`), une interface web locale (`src/interfaces/web/`)
et un bot Telegram (`src/interfaces/telegram/`). Les intégrations
mail/calendrier et l'application de vibe-coding sont prévues mais ne sont pas
implémentées.

## Stack technique

- TypeScript strict, Node.js 24+ attendu, pnpm 9.15.4.
- LangGraph.js pour l'état et l'orchestration.
- `@langchain/openai` contre l'endpoint OpenAI-compatible de NVIDIA.
- NVIDIA est le provider par défaut, avec DeepSeek et Groq également supportés
  via `LLM_PROVIDER` ou `/provider`; le modèle par défaut est
  `deepseek-ai/deepseek-v4-flash`.
- SQLite local (`node:sqlite`, natif à Node — aucune dépendance native
  supplémentaire) via un `SqliteSaver` écrit à la main dans
  `src/core/memory/checkpointer.ts`, partagé par le CLI et le serveur web.
- `chalk`, `dotenv` et `zod` pour le CLI, la configuration et les outils ;
  aucun framework serveur (le serveur web utilise `node:http` directement).

## Architecture du repo

- `src/core/logger.ts` : `log(prefix, message)` partagé par `graph.ts`,
  `server.ts` et les outils qui journalisent leurs propres diagnostics
  (`tools/agents.ts`, `tools/schedules.ts`) — écrit toujours dans
  `ultron-web.log`, et sur stderr seulement si `disableConsoleEcho()` n'a
  pas été appelé. Le CLI l'appelle en tout premier dans `main()` : il prend
  le contrôle du terminal en mode brut et redessine tout l'écran depuis son
  propre buffer (`transcript`), donc un `console.error` isolé (ex. la ligne
  de debug `[graph] agent start thread=...`) atterrissait littéralement au
  milieu d'une réponse affichée — corrigé en centralisant tous ces appels
  derrière ce logger désactivable plutôt qu'en les retirant (le fichier de
  log reste alimenté normalement, y compris pour le CLI).
- `src/interfaces/cli/index.ts` : point d'entrée CLI, affichage, streaming, statistiques,
  jauge de contexte et interruption Ctrl+C. `formatToolResult` y donne un
  rendu dédié par outil (web_search : résultats numérotés avec URLs en
  cyan soulignées ; fetch_url/http_request : en-tête status/url en dim,
  corps tronqué ; spawn_agent : préfixe `[agent]` distinct) au lieu du
  dump générique gris uniforme utilisé auparavant pour tout ; tout le
  reste passe par une troncature générique (`capForDisplay`, ~1400
  caractères/16 lignes affichés, le modèle garde le contenu complet) pour
  qu'un gros résultat n'inonde plus le terminal. Réutilisé à la fois par
  le flux live et par `showRestoredMessages` (relecture d'un chat) pour
  un rendu identique. La ligne de stats `/verbose` (`formatTurnStats`,
  `src/core/llm/usage.ts`, partagée avec `server.ts`) affiche désormais
  `model | X in | Y out | Zs | $coût` (ex. `deepseek-v4-flash | 7,688 in |
  303 out | 10s | $0.14`) au lieu du seul temps écoulé/tokens de sortie ;
  le coût est une estimation configurable (`NEMOTRON_PRICE_IN_PER_M`/
  `NEMOTRON_PRICE_OUT_PER_M`, `.env.example`), pas un tarif réel de
  NVIDIA NIM qui n'en publie pas.
- `src/interfaces/web/server.ts` + `src/interfaces/web/public/` : interface web locale (HTTP + SSE),
  sidebar de gestion des chats (créer, renommer, supprimer, changer de chat) ;
  frontend HTML/CSS + modules ES natifs (`public/js/*.js`), sans framework ni bundler.
  Refonte complète (2026-07-16) : palette de commandes `⌘/Ctrl K` (chats + recherche plein
  texte cross-chat + commandes), actions au survol des messages (copier, brut/rendu, éditer/
  régénérer sur le dernier tour de chaque rôle uniquement, seule chose que `prepareEdit`/
  `prepareRetry` côté backend peuvent défaire), blocs d'appel d'outil badgés par scope, et un
  panneau réglages/raccourcis coulissant avec bascule clair/sombre/système manuelle.
  Second redesign (2026-07-20), style ChatGPT (colonne de conversation centrée ~768px,
  blocs de message pleine largeur sans bulles, teinte de fond subtile côté utilisateur,
  regroupement chronologique de la sidebar) : la sidebar affiche désormais **tous** les
  chats — y compris les conversations `spawn_agent` et les exécutions planifiées, qui
  étaient auparavant filtrées hors de la liste principale et parfois invisibles de partout
  (un chat à la fois `agentId` et `scheduleId` n'apparaissait dans aucun panneau) — groupés
  par Aujourd'hui/Hier/7 derniers jours/mois, avec un badge (🤖/⏰) distinguant le type de
  conversation ; `automation.js` ne sert plus qu'à la gestion agents/schedules (création,
  suppression), plus à parcourir leurs conversations. Le dashboard santé
  (`public/js/healthView.js`, remplace l'ancienne page séparée `health.html`/`health.js`,
  supprimées) est maintenant une vue basculée à la place de `#thread`/`footer` dans la même
  page plutôt qu'une page à part, accessible via le bouton "🩺 Health" de la sidebar ou la
  commande `/health`. La palette de commandes couvre désormais littéralement toutes les
  commandes du CLI (`/model`, `/security`, `/permissions`, `/theme`, `/memory`, `/health`,
  `/export`, `/main`, `/delete` ont été ajoutées — elles n'étaient pas dans la liste
  `COMMANDS` du composer malgré l'existence de la capacité backend correspondante), avec
  deux nouvelles routes `GET|DELETE /api/memory` + `DELETE /api/memory/:id` côté serveur
  pour exposer les observations passives (`UserModelRegistry`) qui n'étaient joignables
  qu'en CLI. Un widget d'état persistant pour le mode `/task goal` (`goalWidget.js`) a été
  ajouté dans le header — auparavant ce mode n'avait aucun affichage continu, seulement des
  notes système éphémères pendant un flux, alors que `GET /api/status` renvoie déjà l'objet
  `Goal` complet. Les trois boutons du composer (modèle, mode de tâche, permission d'outil)
  sont inchangés — c'était la seule exigence explicite de conservation.
- `src/core/graph.ts` : prompt système, graphe agent/outils, routage,
  nettoyage de l'historique, retries des erreurs transitoires ou faux appels.
  Archive/reprise de conversation vit désormais dans `ChatRegistry`
  (`archive`/`unarchive`/`listArchived`, `src/core/memory/chats.ts`) — un
  simple flag `archived_at` sur la ligne du chat, pas un export texte : le
  checkpoint LangGraph du thread n'est jamais touché, donc `/resume`
  rouvre la conversation avec tout son contexte (y compris les appels
  d'outils), contrairement à l'ancien mécanisme `archiveThread`/
  `resumeThread` qui écrivait un fichier `.txt` (perdait tout sauf le texte
  humain/IA) et a été supprimé.
- `src/core/llm/nemotron.ts` : construction du client ChatOpenAI configuré pour NVIDIA.
- `src/core/memory/checkpointer.ts` : `SqliteSaver` (implémente `BaseCheckpointSaver`
  de LangGraph sur `node:sqlite`) — c'est ce fichier qui permet au CLI et au
  serveur web de partager mémoire et commandes : chaque processus ouvre sa
  propre connexion vers le même fichier `.sqlite3`.
- `src/core/memory/chats.ts` : `ChatRegistry` — la liste des chats (id, titre,
  horodatages) dans ce même fichier SQLite ; l'`id` d'un chat sert aussi de
  `thread_id` LangGraph. Le CLI garde un « chat courant » par processus (repris
  au démarrage sur le chat le plus récemment actif, toutes interfaces confondues) ;
  `/archive` clôture le chat courant et en démarre un nouveau au lieu de quitter,
  pour que le chat archivé reste consultable depuis la sidebar web.
- `src/core/tools/` : outils avec scopes déclarés dans `index.ts` : shell,
  fichiers, HTTP/web, processus, date/heure courante, tâches planifiées,
  sous-agents, `open_app`/`applescript_run` (`macos.ts` — lancer une app
  macOS par son nom via `open -a`, ou piloter une app qui expose un
  dictionnaire AppleScript/JXA comme Finder, Notes, Calendar, System
  Events — préférés à un agent générique de contrôle GUI par clics/pixels,
  abandonné après plusieurs tentatives : les modèles disponibles via
  l'API NVIDIA n'étaient pas assez fiables pour du clic à l'aveugle
  autonome, voir l'historique git de `src/core/computerUse.ts` supprimé),
  et une to-do list par chat (`todo_write`/`todo_read`,
  `src/core/memory/todos.ts`) que le modèle tient à jour sur les tâches
  longues et que l'UI web affiche en direct dans un panneau à droite
  (`public/js/todos.js`, `GET /api/chats/:id/todos`). La seule consigne
  écrite dans `AGENT.md` ne suffisant pas à faire suivre `todo_write` de
  façon fiable par Nemotron, l'UI web ajoute un sélecteur explicite
  « task mode » (None / To-Do / Plan, à côté du raisonnement et de la
  sécurité) qui injecte une directive `<task_mode>` juste avant le tour
  courant (`taskModeDirective` dans `graph.ts`, propagé par
  `configurable.taskMode` depuis `/api/turn` et `/api/approve`) — un mode
  choisi par l'utilisateur plutôt qu'une inférence du modèle. Le CLI a la
  même chose via `/task none|todo|plan` (`src/interfaces/cli/index.ts`,
  variable locale `taskMode` propagée au `configurable` de `graph.stream`,
  comme `/think`) ; l'approbation d'un `plan_propose` y a aussi un rendu
  dédié dans `promptToolApproval` (plan numéroté, prompt « start? »)
  au lieu du bloc JSON générique utilisé pour les autres outils. Un second
  rappel plus court (`taskModeReminder`) est en plus ajouté après tout
  l'historique, juste avant l'appel au modèle, car un run réel a montré
  que la directive seule en tête du system prompt ne suffisait pas
  toujours (six recherches avant le premier `todo_write`) ; ce rappel
  change de formulation selon que `todo_write` a déjà été appelé ou non
  dans le tour courant (`todoStartedThisTurn`). La détection des faux
  appels d'outils écrits en texte (`extractFakeToolCall`) a aussi été
  généralisée : elle reconnaît maintenant n'importe quel outil (pas
  seulement `schedule_task`) sous trois formes, y compris encadré par
  `<tool_call>...</tool_call>` ou une fence ```json — un vrai `todo_write`
  émis sous cette forme atterrissait auparavant comme réponse finale
  cassée au lieu d'être exécuté ou corrigé par un retry.
- Un run en mode "To-Do" a aussi montré le modèle rappeler `todo_write`
  (liste entière) juste pour clore le dernier item, au lieu de ne changer
  que son statut — risque de perte/renumérotation du reste de la liste.
  Ajout de `todo_update` (`index`, `status?`, `content?`) qui modifie un
  seul item par sa position 1-based ; `todo_write` est réservé à la
  création initiale et à la restructuration du plan. Les directives de
  `taskModeDirective`/`taskModeReminder` et `AGENT.md` disent maintenant
  explicitement de préférer `todo_update` pour les changements de statut.
- `src/core/memory/goals.ts` (`GoalRegistry`) + `src/core/goalJudge.ts` +
  the CLI's `/task goal` mode (`src/interfaces/cli/index.ts`) : **CLI-only**
  goal mode, not wired into the web UI. `"goal"` is a fourth value of
  `TaskMode` (`graph.ts`) alongside `none`/`todo`/`plan` — `/task goal` just
  arms the mode exactly like `/task todo`/`/task plan` do, with no argument.
  There is no separate `/goal` command and no pause/resume/clear/status
  subcommands: the next non-retry message the user sends while in goal mode
  becomes the objective (`goals.set(...)`, called from the same
  turn-boundary spot that clears the todo list for todo/plan mode) and runs
  as a normal turn; after that turn `driveGoalLoop` calls a *separate*
  short-lived LLM call (`judgeGoal`, `createNemotronModel("low")`) that
  reads only the worker's final reply plus a bounded `git status`/`git diff
  HEAD` snapshot (`gatherCodeContext`, capped ~6k chars) — deliberately not
  the full tool-call history, so the judge has its own small, cheap context
  instead of re-consuming everything the main turn just spent. On
  "continue" it appends a corrective `[Goal check] ...` human-role message
  (`buildContinuationPrompt`) and replays `executeTurn` (the same
  tool-approval-aware turn path a human-typed message gets — extracted out
  of the old inline main-loop code specifically so the goal loop reuses it
  verbatim, not a simplified copy) automatically, with no user input, up to
  `GOAL_MAX_TURNS` (default 20) before self-pausing. "done" marks the goal
  complete; "blocked" pauses it. Every `goals.set(...)` call unconditionally
  overwrites whatever goal existed for the chat before — there's no
  "already active" guard and no resume-by-command: a paused/blocked goal is
  simply superseded by the next message sent in goal mode, same as todo/plan
  discarding a stale list at the next turn boundary. Ctrl+C aborts a
  goal-loop turn (or the judge call itself) the same way it aborts a normal
  turn. `taskModeDirective`/`taskModeReminder` (`graph.ts`) short-circuit to
  `""` for `mode === "goal"` — the model just sees a normal user message,
  since the loop is driven entirely on the CLI side, not via a system-prompt
  directive like todo/plan.
- `AGENT.md` / `SOUL.md` : règles opérationnelles et personnalité, concaténées
  au démarrage ; ils ne doivent pas être fusionnés.
- `PLAN.md`, `README.md` et `docs/agent-ia-personnel.md` : périmètre,
  feuille de route et recherche historique en français.

## Exécution locale

Pré-requis : Node.js 24+, pnpm, et un fichier `.env` basé sur `.env.example`
contenant `NVIDIA_API_KEY`. Aucune base de données externe à démarrer — le
fichier SQLite est créé automatiquement au premier lancement.

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm dev        # CLI
pnpm web        # interface web (http://localhost:4173 par défaut)
pnpm start
pnpm start:web
```

Il n'existe actuellement ni script de test ni script de lint. Le démarrage
réel dépend de l'accès API NVIDIA ; le build et le typecheck en sont
indépendants.

## Configuration et secrets

- `NVIDIA_API_KEY` : obligatoire, chargé par `src/config.ts`.
- `NEMOTRON_MODEL` : optionnel ; valeur par défaut documentée ci-dessus.
- `NEMOTRON_BASE_URL` : optionnel ; défaut `https://integrate.api.nvidia.com/v1`.
- `DATABASE_PATH` : optionnel ; défaut `ultron-state.sqlite3` à la racine du
  projet — fichier de checkpoint partagé par le CLI et le serveur web.
- `GRAPH_RECURSION_LIMIT` : optionnel ; défaut `150`. LangGraph compte
  chaque visite de nœud (pas chaque appel d'outil) contre sa limite par
  défaut de 25 — un tour en mode To-Do/Plan avec plusieurs sous-tâches,
  chacune suivie de son propre aller-retour `todo_update`, la dépassait
  largement sur une tâche par ailleurs saine (`GRAPH_RECURSION_LIMIT`
  atteint). Propagé à tous les appels `graph.stream`/`graph.invoke`
  (CLI, serveur web, tâches planifiées, `spawn_agent`).
- Le mode "Plan" ne se contente plus de forcer `todo_write` en amont : il
  utilise un nouvel outil `plan_propose` (`src/core/tools/plan.ts`, même
  forme que `todo_write` sans le champ `status`) qui **suspend toujours**
  l'exécution pour une confirmation explicite de l'utilisateur, quel que
  soit le mode de sécurité du chat (cas spécial dans `needsApproval` de
  `toolsNode`, `graph.ts` — ce n'est pas la porte de sécurité
  bypass/accept_edit/manual, c'est le contrôle de workflow propre à "Plan").
  Réutilise entièrement le mécanisme `interrupt()`/`Command`/`/api/approve`
  déjà en place pour l'approbation des outils destructifs. Sur refus, le
  `ToolMessage` renvoyé au modèle lui dit explicitement de discuter en
  langage naturel plutôt que de rappeler `plan_propose` immédiatement ; sur
  acceptation, l'outil s'exécute réellement et écrit le plan dans le même
  registre que `todo_write`/`todo_update`. `taskModeReminder`/`taskModeDirective`
  et l'UI web (`addApprovalBlock` dans `thread.js`, rendu dédié "Plan
  proposé" avec boutons Start/Discuss) reflètent ce cycle
  propose → (accepte → exécute) | (refuse → discute → re-propose).
- `GOAL_MAX_TURNS` : optionnel ; défaut `20`. Nombre de tours d'auto-continuation
  que le mode `/task goal` (CLI uniquement, voir ci-dessus) s'autorise avant
  de se mettre en pause tout seul.
- `WEB_PORT` : optionnel ; défaut `4173`, port de l'interface web locale.
- `CONTEXT_WINDOW_TOKENS` : optionnel ; défaut `262144`, utilisé uniquement
  pour la jauge de contexte.
- `.env` est ignoré par Git ; `.env.example` est le contrat de configuration.

## Qualité et tests

Le compilateur TypeScript est strict et `pnpm typecheck`, `pnpm test` (6 tests)
ainsi que `pnpm build` passent actuellement. Il n'y a pas encore de lint ni de
CI. La couverture est faible par rapport à la surface du projet : les zones
les plus importantes à couvrir sont le routage agent/outils, les retries et le
nettoyage des faux appels, le Ctrl+C, les outils fichiers/processus, le
serveur HTTP/SSE, les interruptions et le checkpointer SQLite.

## Risques techniques

1. Les outils shell, fichiers, HTTP et processus ont un accès direct et aucun
   garde-fou d'autorisation : c'est une décision explicite du projet, mais
   l'impact d'un mauvais appel est élevé.
2. Les appels d'outils dépendent encore de la fiabilité du modèle Nemotron ;
   le mécanisme de retry atténue les faux appels mais ne les élimine pas.
3. Le nombre de tokens générés par tour est désormais exact (usage réel
   renvoyé par NVIDIA sur le dernier chunk du stream, voir
   `src/core/llm/nemotron.ts`) ; seule la jauge de contexte totale reste une
   estimation approximative (chars/4), car elle inclut l'historique complet
   sans relancer d'appel.
4. La mémoire est un fil SQLite unique et persistant, partagé par le CLI et
   le serveur web ; une corruption ou une pollution d'historique affecte
   directement les deux interfaces. Le `SqliteSaver` étant écrit à la main
   (pas de package officiel compatible avec les versions actuelles de
   `@langchain/core`/`langgraph`), toute divergence avec le comportement
   attendu de `BaseCheckpointSaver` reste à la charge du projet.
5. Le parsing HTML et la recherche DuckDuckGo sont volontairement légers et
   peuvent échouer sur des pages dynamiques ou des changements de format.
6. `src/interfaces/web/server.ts` lit actuellement les corps HTTP sans plafond
   et accepte les uploads base64 sans limite de taille : un client du réseau
   Tailscale peut donc provoquer une forte consommation mémoire/disque.
7. La continuation du mode `goal` crée un nouvel `AbortController` dans un
   appel imbriqué sans le relier à la fermeture de la requête HTTP ; une
   déconnexion du navigateur peut laisser la continuation consommer des tours
   et des tokens.

## Prochaines actions recommandées

1. Ajouter des tests unitaires ciblés sans changer la posture de sécurité
   choisie.
2. Le bot Telegram a maintenant la parité complète avec les commandes CLI (voir PLAN.md,
   phase 2) ; améliorations possibles plus tard : vrai streaming incrémental (actuellement un
   seul message replié par tour), approbation d'outil par appel plutôt que par lot. Ne pas
   démarrer la phase vibe-coding.
3. Concevoir les intégrations mail/calendrier et leur OAuth avant d'ajouter
   leurs outils.
4. Ajouter des limites de taille aux corps HTTP/uploads et propager
   l'annulation de la requête aux continuations de `goal`.
5. Ajouter des tests d'intégration du serveur HTTP/SSE et du scheduler, puis une
   CI minimale (`typecheck`, `test`, `build`).
6. Concevoir les intégrations mail/calendrier et leur OAuth avant d'ajouter
   leurs outils.
7. Corriger les écarts documentaires au fur et à mesure de chaque nouveau
   changement de code, conformément à `AGENTS.md`.

## Export en direct d'une conversation

- `src/core/memory/exporter.ts` : un chat peut avoir un fichier d'export
  actif (`Chat.exportPath`, colonne `export_path` dans `chats`,
  `ChatRegistry.setExportPath`) — pas un dump ponctuel, un fichier Markdown
  réécrit intégralement (écriture atomique tmp+rename) après chaque tour
  réussi. Plusieurs chats peuvent chacun avoir leur propre export actif en
  parallèle sans se marcher dessus : le chemin par défaut
  (`defaultExportPath`) inclut le slug du titre et les 8 premiers
  caractères de l'id du chat, donc deux chats au même titre n'écrasent
  jamais le même fichier. Racine par défaut : `exports/` à côté du fichier
  SQLite (`dirname(config.databasePath)`), un chemin explicite peut être
  relatif à ce dossier ou absolu.
- Commande `/export [path|on|off]`, identique sur les trois interfaces
  (CLI local `src/interfaces/cli/index.ts`, CLI distant
  `src/interfaces/cli/remote.ts` via `GET|POST|DELETE
  /api/chats/:id/export`, web via les mêmes routes, Telegram
  `src/interfaces/telegram/index.ts`) : bare affiche l'état, un chemin ou
  `on` démarre l'export (et écrit immédiatement), `off` l'arrête sans
  supprimer le fichier déjà écrit.
- Hook de réécriture après chaque tour : `executeTurn` (CLI local, avant
  son `return` final), `handleTurn`/`handleApprove` (serveur web, juste
  après chaque appel à `streamGraphTurn`), `runSingleTurn` (Telegram, avant
  son `return`) — les trois appellent `maybeExportChat(graph, chat)`, qui
  ne fait rien si `exportPath` est `null` (donc sûr à appeler
  inconditionnellement à la fin de chaque tour, y compris en mode goal où
  ces fonctions sont rappelées en boucle).

## To-do : persistance par chat et reprise de tâche non liée

La liste to-do (`memory/todos.ts`) est scoppée par `chat_id`, donc elle
survit indéfiniment à travers les tours d'un même chat — y compris un
redémarrage d'ULTRON (SQLite persiste) suivi d'une demande totalement sans
rapport dans le même chat. `todoState()` (`graph.ts`) ne regardait que
« la liste est-elle vide ou non » pour décider d'autoriser `todo_write`,
donc une demande sans rapport avec une liste déjà existante faisait
continuer/mettre à jour l'ancienne liste au lieu d'en repartir sur une
nouvelle — reproduit et corrigé sur deux fronts :
- **Déterministe** : `TodoRegistry.clear()` +
  `DELETE /api/chats/:id/todos` + bouton "✕" dans l'en-tête du panneau
  web (`todos.js`) — l'utilisateur peut toujours forcer un nouveau départ
  sans dépendre du jugement du modèle.
- **Consigne** : `taskModeDirective`/`taskModeReminder` (`graph.ts`) et
  `AGENT.md` disent maintenant explicitement de repartir d'un `todo_write`/
  `plan_propose` neuf (pas `todo_update`) si la demande courante n'est pas
  la continuation de ce que la liste existante suivait.

## Modèle utilisateur passif (parité Hermes Agent)

Ajouté pour combler un écart identifié face à Hermes Agent (voir
`docs/agent-ia-personnel.md`, section 2) : une mémoire qui apprend en
continu, sans qu'on le lui demande, plutôt qu'uniquement sur déclaration
explicite de l'utilisateur (`MEMORY.md`, `memory_write`).

- `src/core/memory/userModel.ts` (`UserModelRegistry`) : table SQLite
  `user_model_observations`, globale (pas scoppée par chat, comme
  `MEMORY.md`) — chaque ligne est une observation courte
  (`preference`/`fact`/`pattern`) avec sa source (`chat_id` d'origine) et sa
  date. Volontairement **séparée** de `MEMORY.md` : ce fichier reste la
  mémoire éditée et validée à la main par l'utilisateur, jamais réécrite
  automatiquement — voir l'historique du projet (incident OpenClaw,
  suppression de mails malgré l'instruction d'attendre) qui est la raison
  d'être de tout ULTRON ; reproduire la même perte de contrôle côté mémoire
  aurait été absurde.
- `src/core/userModelExtractor.ts` : après chaque tour réussi (CLI
  `executeTurn`, web `streamGraphTurn`), un appel LLM séparé et bon marché
  (`createNemotronModel("low")`, même schéma que `judgeGoal` dans
  `goalJudge.ts`) lit uniquement le dernier échange (message utilisateur +
  réponse d'ULTRON, pas tout l'historique) et répond soit `{"observation":
  null}`, soit une observation courte. Jamais attendu par le flux principal
  (`void recordUserModelObservation(...)`) : une extraction ratée est
  silencieuse, jamais bloquante ni remontée à l'utilisateur.
- `graph.ts` : `buildSystemPrompt` injecte un nouveau bloc `<user_model>`
  (même mécanisme que `<daily_memory>`), entre `<memory>` et
  `<daily_memory>`, résumant les observations accumulées (plafonné à 40
  pour ne pas faire grossir le prompt sans limite). Absent du prompt d'un
  sous-agent (`buildAgentSystemPrompt`), pour la même raison que
  `MEMORY.md` en est déjà exclu.
- `/memory` (CLI uniquement, `src/interfaces/cli/index.ts`) : liste les
  observations accumulées (`/memory`), les efface toutes (`/memory clear`)
  ou une seule par id (`/memory forget <id>`) — la surface de revue/purge
  explicitement promise avant l'implémentation, pas de fusion automatique
  vers `MEMORY.md`.
- Pas encore fait : promotion explicite d'une observation vers `MEMORY.md`
  (l'utilisateur ou ULTRON, sur demande, édite `MEMORY.md` à la main via les
  outils fichiers existants — aucun outil dédié pour l'instant), et aucune
  passe de consolidation/dédoublonnage des observations dans le temps.
