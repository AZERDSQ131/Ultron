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
  server (no Express) and a vanilla HTML/CSS + native-ES-modules frontend (no framework, no
  bundler — `public/js/*.js` loaded directly via `<script type="module">`), consistent with owning
  the loop instead of delegating to one
- Redesigned (2026-07-16) into a full control-panel UI on top of the same backend: a
  `⌘/Ctrl K` command palette merging chat switching, cross-chat full-text search
  (`GET /api/search`, backed by `searchMessages()` in `graph.ts`) and slash commands; per-turn
  hover actions (copy, raw markdown toggle, and — only on the last turn of each role, since
  that's all the backend's `prepareEdit`/`prepareRetry` can undo — edit or regenerate); tool-call
  blocks badged by declared scope; and a settings/shortcuts slide-over (`⌘,` / `⌘/`) with a manual
  light/dark/system theme toggle. Design tokens (color, type scale) live at the top of `style.css`;
  dropped the earlier scanline/glow treatment in favor of a plainer dark-with-red-accent identity
  that also has a fully considered light theme, not an inversion.
- Shares the same SQLite database as the CLI — the CLI and the web UI are two views onto the
  same chats, not two disconnected sessions. Each process opens its own connection to the same
  file; a write from one is visible to the other on its next read (see
  `src/core/memory/checkpointer.ts`)
- `/compact`, `/retry` and `/archive` are exposed as web API routes too (`/api/compact`,
  `/api/turn` with `retry: true`, `/api/archive`, `/api/resume`) and recognized as slash commands
  by the web frontend, so commands behave the same regardless of which interface issues them
- `pnpm web` (dev) / `pnpm start:web` (compiled) — port via `WEB_PORT`, default `4173`
- Second redesign (2026-07-20), ChatGPT-pattern-inspired: message column capped ~768px and
  centered, full-width message blocks with a subtle background tint on user turns instead of
  bubbles, and the sidebar now groups **every** chat chronologically (Today/Yesterday/Previous
  7 days/month buckets) — including `spawn_agent` and scheduled-task runs, previously filtered
  out of the main list entirely (a chat with both `agentId` and `scheduleId` set was reachable
  from neither the Agents panel nor the Schedules list). A small badge (🤖 agent, ⏰ scheduled
  run) distinguishes chat type instead of splitting them into separate surfaces;
  `automation.js` is now pure agent/schedule CRUD, not a second place to browse conversations.
  The health dashboard (see "Health module" below) was folded into the app shell as a view
  (`public/js/healthView.js`, swapped in for `#thread`/footer) instead of a standalone
  `health.html` page unreachable from the main UI. The composer's command palette now covers
  every CLI command (previously `/model`, `/security`, `/permissions`, `/theme`, `/memory`,
  `/health`, `/export`, `/main`, `/delete` weren't in the client's command list even though the
  backend capability existed) — added `GET|DELETE /api/memory` + `DELETE /api/memory/:id` for
  web parity with the CLI's `/memory` (passive `UserModelRegistry` observations). A persistent
  goal-mode status widget (`goalWidget.js`) in the header now reflects `/api/status`'s `Goal`
  object continuously instead of only showing ephemeral system notes during a live stream. The
  composer's three required controls (model picker, task-mode button, tool-approval/security
  button) are unchanged.

Chosen over a single always-on server process that the CLI would connect to as a client: that
would force the server to always be running first and would centralize a single point of failure.
Two independent processes sharing one SQLite file keeps the CLI fully usable standalone (as before)
while still merging state — the trade-off is that two writes at the exact same instant from both
interfaces could theoretically race; acceptable for a single-user local tool used from one
interface at a time.

## Multiple chats + sidebar (done)

- Conversations stopped being a single hardcoded thread (`"ultron-main"`). `src/core/memory/chats.ts`
  (`ChatRegistry`) tracks every chat — id, title, `createdAt`/`updatedAt` — in the same SQLite
  database file; a chat's `id` doubles as its LangGraph `thread_id`, so no change was needed to
  how the checkpointer itself stores messages.
- Web UI: a sidebar (new `#sidebar` in `index.html`) lists every chat, sorted by recent activity.
  New chat, rename (inline edit), delete (with confirmation, also purges that chat's checkpoint
  rows via `SqliteSaver.deleteThread`), and switching — each fetches the chat's message history
  from `GET /api/chats/:id/messages` and replays it into the thread view.
- Titles are auto-derived from each chat's first message (`ChatRegistry.maybeAutoTitle`) unless
  the user renames it manually — renaming permanently opts a chat out of auto-titling.
- CLI: no sidebar (it's a terminal), but it participates in the same registry. It keeps one
  "current chat" per process, resuming whichever chat was most recently active on *either*
  interface at startup — not always the same one. Running `/archive` now finalizes the current
  chat (still writes the existing human-readable `.txt` export too) and starts a fresh chat
  instead of just dumping a file, so the archived conversation stays visible and clickable from
  the web sidebar afterwards — this is what actually connects "`/archive` on the CLI" to
  "show up in the web UI".
- The pre-existing hardcoded thread id (`"ultron-main"`, exported as `LEGACY_CHAT_ID` from
  `chats.ts`) is registered into the chat table on startup via `chats.ensure(...)`, so upgrading
  doesn't orphan whatever history already existed.

## Phase 2 — Telegram interface (done)

- `src/interfaces/telegram/index.ts` (grammY, long polling — `pnpm telegram` / `start:telegram`), a
  third entry point next to the CLI and web UI: same `buildGraph()`, same shared SQLite file, so a
  Telegram conversation has the same memory, tools and personality as the other two.
- Which ULTRON chat a Telegram chat points at is a movable pointer (`TelegramLinkRegistry`,
  `src/core/memory/telegramLinks.ts`), not a fixed derivation — `/archive` and `/resume` both
  repoint it, mirroring the CLI's "current chat per session" model despite Telegram having no
  sidebar of its own. Every chat it touches is a normal row in `ChatRegistry`, visible from the web
  sidebar too.
- No true token-by-token streaming: Telegram rate-limits `editMessageText`, so a single placeholder
  message is sent per turn, updated only when the active tool's name changes (a coarse "what's it
  doing" indicator) and once more with the final text.
- Tool-approval interrupts (`accept_edit`/`manual` security mode) render as one inline-keyboard
  Approve/Deny covering the whole pending batch — not per-call like the CLI's y/n prompt or the
  web's approval block, since Telegram's UI doesn't lend itself to that level of granularity.
- Full CLI command parity: `/help`, `/model`, `/status`, `/context`, `/stop`, `/retry`, `/compact`,
  `/archive`, `/resume`, `/think`, `/task` (including `goal` mode's judge-then-continue
  loop, ported as a sequential loop of independent turns — see `runTurn`'s comment on why it must
  not recurse into a still-held per-chat lock, the way `server.ts`'s SSE goal continuation currently
  does), `/permissions`, `/security`, `/verbose`, `/memory`, `/clear`, `/theme`, `/quit`. Interactive
  CLI pickers (arrow-key selection) become inline keyboards; `/theme` is an intentional no-op
  (Telegram's own app controls that, not ULTRON).
- `/clear` wipes the conversation's actual message state (`clearThreadMessages` in `graph.ts`, a
  `RemoveMessage(REMOVE_ALL_MESSAGES)` update), on top of deleting what
  Telegram lets a bot delete of its own recent messages (own messages only, ~48h window). This is
  deliberately different from the CLI/web, where `/clear` only redraws the terminal and leaves the
  model's memory of the thread untouched — there the visible scrollback is a constant reminder that
  history persists, so that's a reasonable reading of "clear"; Telegram shows no such reminder, and
  a real report confirmed the confusion (saying "Salut" again after `/clear` got a reply that
  referenced the pre-clear greeting).
- Replies are converted from ULTRON's Markdown (`**bold**`, `` `code` ``, `# headers`,
  `~~strikethrough~~`, `[text](url)`) to Telegram's HTML parse mode (`src/interfaces/telegram/format.ts`,
  `markdownToTelegramHtml`) rather than MarkdownV2 — MarkdownV2 requires escaping a long list of
  punctuation anywhere it appears outside formatting, exactly what an LLM's free-form prose trips
  over; HTML only needs `&`/`<`/`>` escaped, which is mechanical. Falls back to the plain
  unformatted text (still truncated to Telegram's 4096-char limit) if the converted HTML is
  oversized or fails to parse for any reason, rather than losing the message.
- `stripThinking` (`telegram/index.ts`) removes any `<think>...</think>` chain-of-thought Nemotron's
  raw content stream includes inline when reasoning is on (`/think on`/`full`) — the CLI/web don't
  surface it either, but only Telegram was reported actually leaking the literal tags into the
  user-visible reply. Also drops a dangling, never-closed `<think>` (turn interrupted mid-reasoning)
  rather than showing a half-finished fragment.
- The `/verbose` stats line is sent as its own separate message, after the reply — not appended to
  it — since it's a distinct piece of information, not part of the answer.
- Session state with no natural persistence slot (`thinkingMode`, `taskMode`, `verbose`) is
  in-memory per ULTRON chat, reset on bot restart — same lifetime as the CLI's process-local
  variables.

## Phase 3 — Tools (in progress)

- Tools declared with an explicit scope: `read` / `write` / `destructive` (kept in code for clarity even though confirmation gates are off by default per current settings) — see `src/core/tools/index.ts`
- Done: `run_shell_command`, `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `fetch_url`, `http_request`, `web_search`, `list_processes`, `kill_process`, `get_current_datetime`, `schedule_task`, `spawn_agent` — the web/process tools are modeled on OpenClaw's own tool categories (`exec`, `web_search`, `web_fetch`, `process`)
- `spawn_agent` (`src/core/tools/agents.ts`) lets ULTRON dispatch a sub-agent on demand: it creates or reuses an Agent record, starts a fresh chat owned by it (inheriting the parent chat's tool-approval mode, see below), and returns immediately — it does **not** block the calling turn. The actual run (`graph.stream`, same tool access as ULTRON, capped at `MAX_SPAWN_DEPTH = 3` nested spawns) happens fire-and-forget; when it finishes (or fails, or pauses on its own tool-approval interrupt), `runSpawnedAgent` "wakes" the spawning thread by appending a note and re-invoking *that* thread's graph — a real new ULTRON turn lands in the original conversation once each sub-agent reports back, rather than the user having to go check a separate chat. Scoped `destructive` in `toolScopes`, so the "accept_edit"/"manual" tool-approval modes pause *dispatching* it for confirmation like `run_shell_command` (the sub-agent's own subsequent tool calls are separately gated by its inherited mode). Pulled forward from Phase 4 on explicit request; the rest of the vibe-coding app (a dedicated UI orchestrating many such agents) is still deferred.
- A chat owned by an Agent gets a different system prompt (`buildAgentSystemPrompt` in `src/core/graph.ts`): the Agent's own persona/instructions instead of SOUL.md's ULTRON identity, and no MEMORY.md — without this split, a spawned sub-agent given both "you are ULTRON" (system) and "you are a research agent, do X" (its task) produced confused, off-task replies (it described itself as ULTRON instead of doing the task). AGENT.md's tool-use protocol still applies.
- `src/core/runs.ts` tracks spawn_agent's background runs by chat id (in-process, not persisted) so the web UI can attach to one while it's going and stop it: opening a chat that's still running (`GET /api/chats/:id/messages` now returns `running: true`) opens `GET /api/chats/:id/stream`, an SSE feed of the same text/tool_call/tool_result events a normal turn emits (`composer.js`'s `attachToRunningChat`); `POST /api/stop` now checks both the request-scoped `activeAborts` map and `runs.ts` so the same Stop button works on either kind of run. `listChatMessages` also now surfaces tool calls/results (previously human/ai text only), so a finished sub-agent's chat shows what it actually did instead of reading as empty.
- `src/core/threadLock.ts` serializes every graph execution against a given thread_id, in-process. Needed once several agents could be spawned from one turn: a fast sub-agent's wake-up note (`runSpawnedAgent` in `tools/agents.ts`) landing on the parent chat while the user's own reply was still streaming raced two concurrent Pregel runs on the same SQLite-backed checkpoint thread — observed as stray tool/report text bleeding into an unrelated live reply. `streamGraphTurn` (server.ts), the CLI's per-turn stream loop, `runDueSchedules`, and `runSpawnedAgent`'s parent wake-up call (the sub-agent's own run doesn't need it — its execution chat is freshly created per spawn, so nothing else targets it concurrently) all go through it now; different thread_ids never wait on each other.
- Web search uses a provider abstraction in `src/core/tools/search.ts`: Tavily is selected automatically when `TAVILY_API_KEY` is present, while DuckDuckGo remains the no-key fallback. `fetch_url` validates HTTP(S) URLs, rejects oversized responses and reports non-2xx status clearly.
- Still to come: mail, calendar (both need OAuth setup — bigger lift than the filesystem/shell tools)
- Background scheduled tasks (cron-style) once the core loop is trusted

## iOS app (v1 done)

Native SwiftUI app (`ios/`, iOS 17+, zero external dependency), a fourth client on the same
Tailscale HTTP/SSE model as `cli/remote.ts` — no new backend routes, no auth beyond Tailscale
reaching the server (`ULTRONClient.swift` mirrors `remote.ts`'s API usage: chats, turn/approve
SSE streams, models/provider, tools/skills, finance/health/usage/memory). Built with XcodeGen
(`ios/project.yml` is the source of truth for `ULTRON.xcodeproj`, committed for direct Xcode
opening).

- Menu screen mirrors the web sidebar: modules (Finance, Health, Tokens, Skills, Memory) plus
  a date-grouped chat list, agent-owned chats excluded (parity with `chatList.js`'s filter — no
  Agents panel on mobile yet).
- Chat screen: streamed text bubbles, collapsible tool-call groups with scope badges, a native
  tool-approval card (`interrupt`/`Command`/`/api/approve`, same mechanism as CLI/web), and a
  composer bar with model/task-mode/permission pickers. No collapsible "Thinking" block in v1 —
  the server has no separate reasoning SSE event to consume (`streamGraphTurn` puts everything
  in one `text` event); would need a server-side change to add one.
- Verified manually: builds clean (`xcodebuild`, Swift 6 strict concurrency — `ULTRONClient` is
  `@MainActor` to avoid "sending across isolation domains" errors), launched on an iOS 17
  simulator against a live local `pnpm web` server — menu loads real chats and renders all five
  modules. Full tap-through of every screen wasn't automated (no reliable simulator UI-automation
  tool in this environment); the user should click through the golden path once on a real device
  or simulator.
- Deferred, same as everywhere else: Agents/Schedules panel, Goal mode (CLI-only today), file/photo
  upload from mobile, push notifications.

## Jetson deployment + Mac access (in progress)

Target architecture (see `docs/agent-ia-personnel.md`'s follow-up discussion, not yet written back into that file): ULTRON's process — web server, Telegram bot, database — lives permanently on a Jetson Orin Nano, reachable over Tailscale; the Mac is a client plus a remote-controllable target, not where the graph runs.

- Jetson: repo cloned at `~/ultron` (not the earlier `~/t9-backup/ULTRON`, which was a manual duplicate, not Syncthing-managed, and has been deleted), built, `.env` in place. Two systemd user units are prepared but **not enabled** — `~/.config/systemd/user/ultron-web.service` and `ultron-telegram.service` (the latter still needs `TELEGRAM_BOT_TOKEN` added to `.env` before it can run). Verified manually: the web server answers on both `127.0.0.1:4173` and the Jetson's Tailscale IP.
- `src/interfaces/cli/remote.ts` (new, see Phase "CLI" note below) is the piece that makes `ultron` on the Mac a thin client instead of a local process — this is what the Mac-side `ultron` command should invoke, pointed at the Jetson's Tailscale IP via `ULTRON_SERVER_URL`.
- `src/core/tools/remoteHost.ts` + the `host: "jetson" | "mac"` param on the fs/shell tools + `macos.ts`'s platform-branching (see below) is what lets ULTRON act on the Mac's filesystem/apps once it's running on the Jetson instead of on the Mac itself.
- **Blocked on the user**: Tailscale SSH is enabled on this tailnet and intercepts the Jetson→Mac SSH connection with an interactive per-session browser check (`https://login.tailscale.com/a/...`) — plain key auth (already set up: a fresh `ultron-jetson-to-mac` ed25519 key on the Jetson, its pubkey in the Mac's `~/.ssh/authorized_keys`, a `Host mac` alias in the Jetson's `~/.ssh/config`) can't complete that check non-interactively. Until the user either approves that check once from a browser or adjusts the tailnet's SSH policy/ACL, the `host: "mac"` tool path only works from wherever a session can pass that check — verified instead against a local loopback SSH target (`MAC_SSH_HOST=localhost` on the Mac itself) to prove the tool logic is correct.
- Not yet done: enabling the two systemd services (deliberately left for the user — see "prepare without activating"), `TELEGRAM_BOT_TOKEN` in the Jetson's `.env`, resolving the Tailscale SSH check above.

## Phase 4 — Vibe-coding app (deferred, not started)

- Separate app, Codex-style interface
- One main conversation orchestrates background sub-agents, each managing a project
- Will reuse the tool/memory layers built in phases 1–3 rather than starting over

## Web automation foundation (started)

- Agents are persisted in the shared SQLite database with their own description and specialized instructions.
- Web chats may be owned by an Agent (`agent_id`) while remaining ordinary LangGraph threads.
- The web UI exposes Agent and scheduled-task panels; schedules use five-field cron expressions and can be enabled or disabled.
- Schedules are created by the model through the `schedule_task` tool; the web panel is intentionally read-only for scheduled tasks.
- `schedule_task` supports both recurring cron expressions and one-time delays such as “in one minute”.
- A lightweight web-process scheduler wakes due schedules, creates an execution chat under the owning Agent, and runs the task with that Agent's instructions. CLI behavior is unchanged.

## Tool approval modes (done)

- Per-chat `SecurityMode` (`bypass` | `accept_edit` | `manual`, stored on the `chats` row — see `src/core/memory/chats.ts`), added on explicit request on top of the "no confirmation gates" default.
- `bypass` (default, matches the original posture) runs every tool call immediately. `accept_edit` pauses only `destructive`-scoped calls (`run_shell_command`, `kill_process`, `spawn_agent`) for a human decision. `manual` pauses every call.
- Implemented as a custom `tools` node in `src/core/graph.ts` (replacing LangGraph's prebuilt `ToolNode`) that calls LangGraph's `interrupt()` to pause a paused thread's checkpointed state and resumes via `Command({ resume: decisions })` — a real pause/resume, not a client-side-only gate.
- Web UI: a button next to the composer input (same popover shape as the reasoning-mode button) sets the mode per chat; a pending approval renders inline in the thread with Approve/Deny.
- CLI: `/security bypass|accept_edit|manual` sets it, `/status` shows it; a pending approval prints the batch and asks a single y/n.

## Health module (done — all 6 phases, except calendar correlation)

A daily health-export payload (activity/sleep/heart, e.g. from Health Export Kit) is a real,
queryable data source rather than a JSON blob pasted into chat, with computed scores, anomaly
detection, a biological age estimate, on-demand narration, a web dashboard, and a goal-mode
extension point. All under `src/core/health/` unless noted:

- **Storage/ingestion** (`src/core/memory/health.ts`, `HealthRegistry`, global) — `health_days`
  (raw payload kept forever, never purged, plus flat extracted metrics), `health_baselines`
  (7/30/90-day rolling mean/stddev per metric), `health_profile` (birthdate, sleep target).
  `POST /api/health-data/ingest` (`server.ts`) is the primary ingestion path for an external
  export app/shortcut — the only web route that checks an auth header (`x-health-token` vs
  `HEALTH_INGEST_TOKEN`). `health_ingest`/`health_query`/`health_set_profile` tools
  (`src/core/tools/health.ts`) cover manual ingestion, read queries, and setting birthdate/sleep
  target conversationally.
- **Scores and trends** — `scoring.ts` (`computeRecoveryScore`/`computeActivityScore`, 0-100,
  personal 30-day-baseline z-scores) and `trends.ts` (`detectAnomalies`, personal z-score
  thresholds, including a composite illness/overtraining flag). `HealthRegistry.getRecords()`
  (best sleep, lowest resting HR, activity streak) and `getSleepDebt()` (rolling deficit vs
  personal target).
- **Biological age** — `bioAge.ts` (`estimateBiologicalAge`), an explicitly non-clinical, fully
  explained wellness estimate (every contributing factor listed in `explanation`) from resting
  HR/HRV/sleep efficiency/activity vs a documented adult reference point, adjusted from
  `health_profile.birthdate`.
- **Narration and export** — `narrator.ts` (`narrateHealth`, same cheap-separate-LLM-call
  pattern as `userModelExtractor.ts`/`goalJudge.ts`, fed only already-computed numbers, never raw
  data) behind the `health_report` tool — on-demand only, never auto-pushed by default, per
  explicit user preference (the existing `schedule_task` tool covers it if ever wanted). `export.ts`
  + `health_export` tool for a one-shot Markdown dump of the full history.
- **Web dashboard** — `public/health.html` + `public/js/health.js` (native SVG charts, no
  library), backed by `GET /api/health-data/summary`: recovery/activity score trend, sleep
  duration bars, last night's sleep-stage timeline (parsed client-side from the stored raw
  payload), records, sleep debt, and the biological-age estimate.
- **Goal-mode extension** — `gatherHealthContext()` in `goalJudge.ts` (sibling to
  `gatherCodeContext`), wired into both the CLI's `driveGoalLoop` and the web's `streamGraphTurn`
  judge calls, so a `/task goal` objective about health has the last 7 days of data available to
  the judge alongside any code diff.
- **Not built**: calendar correlation — genuinely blocked, not a scope choice: there is no
  calendar/OAuth integration anywhere in this codebase yet (see roadmap item 3 in `CLAUDE.md`),
  so there's nothing to correlate health data against. Revisit once that integration exists.

## Ground rules carried across every phase

- Full research and the reasoning behind these choices: [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) (French)
- Security posture is intentionally light by user choice (no sandboxing, no logs, and confirmations off by default) — the per-chat tool approval modes above are opt-in, not a silent reintroduction; do not change that default or otherwise reintroduce sandboxing/logging without being asked
- No sub-agents used to *build* ULTRON itself — this project is coded directly
- Every code change is committed and pushed as it happens, no batching
