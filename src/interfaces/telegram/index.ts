import { Bot, InlineKeyboard } from "grammy";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { config, setActiveModel, setActiveProvider, nextConfiguredProvider, hasProviderCredentials, type LlmProvider } from "../../config.js";
import { listModelsByProvider } from "../../core/llm/models.js";
import {
  buildGraph,
  compactThread,
  estimateContextUsage,
  getPendingApproval,
  prepareRetry,
  type TaskMode,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { markdownToTelegramHtml } from "./format.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { formatTurnStats, recordUsage } from "../../core/llm/usage.js";
import { recordUserModelObservation } from "../../core/userModelExtractor.js";
import { autoTitleChat } from "../../core/chatTitler.js";
import { getUserModelRegistry } from "../../core/memory/userModel.js";
import { getHealthRegistry, pickLatestWithData, sparkline, type HealthMetric } from "../../core/memory/health.js";
import { computeActivityScore, computeRecoveryScore } from "../../core/health/scoring.js";
import { detectAnomalies } from "../../core/health/trends.js";
import { getMealExerciseLogRegistry } from "../../core/memory/mealExerciseLog.js";
import { savePhoto } from "../../core/health/photoStorage.js";
import { analyzeHealthPhoto } from "../../core/health/visionAnalyzer.js";
import { narrateLoggedEntry } from "../../core/health/narrator.js";
import { getChatRegistry } from "../../core/memory/chats.js";
import { defaultExportPath, maybeExportChat, resolveExportPath } from "../../core/memory/exporter.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { getGoalRegistry, type Goal } from "../../core/memory/goals.js";
import { getTelegramLinkRegistry } from "../../core/memory/telegramLinks.js";
import { getChatEventRegistry } from "../../core/memory/chatEvents.js";
import { buildContinuationPrompt, gatherCodeContext, judgeGoal } from "../../core/goalJudge.js";
import { tools } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
import { withThreadLock } from "../../core/threadLock.js";
import { log } from "../../core/logger.js";
import { getOpenAIAuthRegistry } from "../../core/memory/openaiAuth.js";
import { requestDeviceCode, pollAndExchange, decodeAccountEmail } from "../../core/llm/openaiAuth.js";

// Third entry point alongside the CLI and the web UI (see CLAUDE.md's
// "Interface" decision) — same buildGraph(), same shared SQLite file, so a
// Telegram conversation shares memory, tools and personality with the other
// two. Every CLI local command has a working equivalent here (see the
// command handlers below); a few are necessarily reinterpreted for a chat
// UI that has no terminal to redraw and no arrow-key pickers — see each
// command's comment for the tradeoff made.

function debugLog(message: string): void {
  log("telegram", message);
}

if (!config.telegramBotToken) {
  throw new Error("Missing environment variable: TELEGRAM_BOT_TOKEN (see .env.example)");
}

const bot = new Bot(config.telegramBotToken);
let graph = buildGraph();
const chats = getChatRegistry(config.databasePath);
const todos = getTodoRegistry(config.databasePath);
const goals = getGoalRegistry(config.databasePath);
const userModel = getUserModelRegistry(config.databasePath);
const health = getHealthRegistry(config.databasePath);
const mealExerciseLog = getMealExerciseLogRegistry(config.databasePath);
const links = getTelegramLinkRegistry(config.databasePath);
const chatEvents = getChatEventRegistry(config.databasePath);

// Ensures pre-existing history from the CLI's original hardcoded thread
// registers as a real chat — same migration every entry point does at
// startup (see chats.ts's LEGACY_CHAT_ID comment). Runs at most once ever
// (see ensureLegacyMigration): if the user later deletes that chat, this
// must not resurrect it on the next restart.
chats.ensureLegacyMigration();

// Which ULTRON chat a Telegram chat currently points at is a movable
// pointer (TelegramLinkRegistry), not a fixed derivation — /archive and
// /resume both repoint it. On first contact from a given Telegram chat,
// adopt `telegram-<id>` if it already has history (an earlier version of
// this file derived the id that way with no indirection), otherwise start
// a brand-new chat.
function currentChatId(telegramChatId: number): string {
  const scope = `telegram:${telegramChatId}`;
  const linked = links.get(telegramChatId);
  if (linked && chats.get(linked)) {
    startEventSync(telegramChatId, linked);
    return linked;
  }
  const chat = chats.activateMain(scope);
  links.set(telegramChatId, chat.id);
  startEventSync(telegramChatId, chat.id);
  return chat.id;
}

const eventCursors = new Map<number, number>();
const eventSyncTimers = new Map<number, ReturnType<typeof setInterval>>();
const eventSyncBusy = new Set<number>();

function startEventSync(telegramChatId: number, chatId: string): void {
  if (eventSyncTimers.has(telegramChatId)) return;
  eventCursors.set(telegramChatId, chatEvents.latestId(chatId));
  const timer = setInterval(async () => {
    if (eventSyncBusy.has(telegramChatId)) return;
    if (links.get(telegramChatId) !== chatId) {
      clearInterval(timer);
      eventSyncTimers.delete(telegramChatId);
      return;
    }
    eventSyncBusy.add(telegramChatId);
    try {
      let cursor = eventCursors.get(telegramChatId) ?? 0;
      for (const event of chatEvents.listAfter(chatId, cursor)) {
        cursor = event.id;
        if (event.source === "telegram") continue;
        if (event.kind === "human") await send(telegramChatId, `🖥️ CLI › ${event.content}`);
        else await send(telegramChatId, event.content);
      }
      eventCursors.set(telegramChatId, cursor);
    } finally {
      eventSyncBusy.delete(telegramChatId);
    }
  }, 750);
  eventSyncTimers.set(telegramChatId, timer);
}

for (const link of links.list()) {
  if (chats.get(link.ultronChatId)) startEventSync(link.telegramChatId, link.ultronChatId);
}

// Per-chat session state that has no natural persistence slot elsewhere
// (unlike security mode, which lives on the Chat row itself) — mirrors the
// CLI's process-local `thinkingMode`/`taskMode`/`verbose` variables. Reset
// on bot restart, same as the CLI resets on process restart.
interface Session {
  thinkingMode: ThinkingMode;
  taskMode: TaskMode;
  verbose: boolean;
  // /show-tools (see runSingleTurn) — off by default: a tool call runs
  // silently behind the "…" placeholder, only the final generated reply
  // ever shows. On: every distinct tool call gets its own standalone
  // message ("⚙ toolname", name only, never its args/result) that is never
  // edited or deleted afterward, unlike the placeholder itself.
  showTools: boolean;
}
const sessions = new Map<string, Session>();
function getSession(ultronChatId: string): Session {
  let session = sessions.get(ultronChatId);
  if (!session) {
    session = { thinkingMode: "full", taskMode: "none", verbose: false, showTools: false };
    sessions.set(ultronChatId, session);
  }
  return session;
}

const sentMessageIds = new Map<number, number[]>();
function trackSent(telegramChatId: number, messageId: number): void {
  const ids = sentMessageIds.get(telegramChatId) ?? [];
  ids.push(messageId);
  if (ids.length > 300) ids.shift();
  sentMessageIds.set(telegramChatId, ids);
}
// Truncated well under Telegram's 4096-char hard cap on the raw markdown
// before conversion, since **bold**/`code` markers grow a little once
// turned into <b>/<code> tags — leaves headroom so the converted HTML
// still fits in the common case instead of needing the plain-text fallback.
const RAW_TEXT_BUDGET = 3500;
const TELEGRAM_MESSAGE_LIMIT = 4096;

function prepareOutgoing(text: string): { raw: string; html: string; htmlFits: boolean } {
  const raw = text.length > RAW_TEXT_BUDGET ? `${text.slice(0, RAW_TEXT_BUDGET)}\n…` : text;
  const html = markdownToTelegramHtml(raw) || "(empty)";
  return { raw, html, htmlFits: html.length <= TELEGRAM_MESSAGE_LIMIT };
}

// ULTRON's replies use Markdown (**bold**, `code`, # headers, ...) — see
// markdownToTelegramHtml's comment for why this converts to Telegram's HTML
// parse mode rather than MarkdownV2. If the converted HTML fails to parse
// for any reason not anticipated here (an edge case in the converter, an
// oversized result), this falls back to the plain, unformatted raw text
// rather than losing the message entirely — delivering something plain
// beats delivering nothing.
async function send(telegramChatId: number, text: string, extra?: Parameters<typeof bot.api.sendMessage>[2]): Promise<{ message_id: number }> {
  const { raw, html, htmlFits } = prepareOutgoing(text);
  if (htmlFits) {
    try {
      const msg = await bot.api.sendMessage(telegramChatId, html, { parse_mode: "HTML", ...extra });
      trackSent(telegramChatId, msg.message_id);
      return msg;
    } catch (err) {
      debugLog(`HTML send failed, falling back to plain text chat=${telegramChatId} error=${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const msg = await bot.api.sendMessage(telegramChatId, raw.slice(0, TELEGRAM_MESSAGE_LIMIT) || "(empty)", extra);
  trackSent(telegramChatId, msg.message_id);
  return msg;
}

const activeAborts = new Map<string, AbortController>();

// Telegram rate-limits editMessageText; editing on every streamed token the
// way the CLI/web do would trip that almost immediately. Instead: one
// placeholder message per turn, updated only when the active tool's name
// changes (a coarse "what's it doing" indicator) and once more with the
// final text. "message is not modified" 400s (editing to identical text)
// are expected and swallowed rather than logged as real errors.
async function safeEditMessage(chatId: number, messageId: number, text: string): Promise<void> {
  const { raw, html, htmlFits } = prepareOutgoing(text);
  if (htmlFits) {
    try {
      await bot.api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("message is not modified")) return;
      debugLog(`HTML edit failed, falling back to plain text chat=${chatId} error=${message}`);
    }
  }
  try {
    await bot.api.editMessageText(chatId, messageId, raw.slice(0, TELEGRAM_MESSAGE_LIMIT) || "(empty reply)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("message is not modified")) debugLog(`edit failed chat=${chatId} error=${message}`);
  }
}

// With reasoning enabled (see /think), Nemotron's raw content stream can
// include its <think>...</think> chain-of-thought inline, ahead of the
// actual reply. The CLI/web don't show it either, but only Telegram was
// reported actually leaking the literal tags into the user-visible message
// — strip it defensively here regardless of which interface's model client
// produced it. Also handles a dangling, never-closed <think> (e.g. the turn
// was interrupted mid-reasoning) by dropping everything from that point on,
// since a half-finished chain-of-thought fragment isn't a usable answer
// either.
function stripThinking(text: string): string {
  let stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  stripped = stripped.replace(/<think>[\s\S]*$/i, "");
  return stripped.trim();
}

function humanTextFromInput(input: { messages: HumanMessage[] } | Command): string | undefined {
  if (!("messages" in input)) return undefined;
  const text = input.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
    .trim();
  return text || undefined;
}

type TurnOutcome = { status: "ok"; finalText: string } | { status: "approval" } | { status: "aborted" };

// One graph.stream() pass, start to finish, inside a single withThreadLock
// acquisition — never called recursively from inside another call for the
// same chat (that reentrancy would deadlock threadLock.ts's per-chat
// queue: the outer call would be waiting on the inner one to run, and the
// inner one waits for the queue slot the still-running outer call is
// holding). The goal auto-continuation loop below (see runTurn) instead
// calls this in a plain sequential while-loop, same shape as the CLI's
// driveGoalLoop — each iteration acquires and fully releases the lock
// before the next one starts.
async function runSingleTurn(
  telegramChatId: number,
  ultronChatId: string,
  input: { messages: HumanMessage[] } | Command,
): Promise<TurnOutcome> {
  const session = getSession(ultronChatId);
  activeAborts.get(ultronChatId)?.abort();
  const abortController = new AbortController();
  activeAborts.set(ultronChatId, abortController);

  const placeholder = await send(telegramChatId, "…");
  let finalText = "";
  let lastToolName: string | undefined;
  let outputTokens: number | undefined;
  let inputTokens: number | undefined;
  const turnStarted = Date.now();

  try {
    return await withThreadLock(ultronChatId, async (): Promise<TurnOutcome> => {
      const stream = await graph.stream(input, {
        configurable: { thread_id: ultronChatId, thinking: session.thinkingMode, taskMode: session.taskMode },
        signal: abortController.signal,
        streamMode: "messages",
        recursionLimit: config.graphRecursionLimit,
      });

      for await (const [chunk] of stream) {
        const type = chunk.getType();
        if (type !== "ai") continue;

        const toolCallChunks = (chunk as unknown as { tool_call_chunks?: { name?: string }[] }).tool_call_chunks;
        if (toolCallChunks?.length) {
          const name = toolCallChunks.find((tc) => tc.name)?.name;
          if (name && name !== lastToolName) {
            lastToolName = name;
            // /show-tools off (default): stays silent behind the "…"
            // placeholder — no tool name leaks out, only the final reply
            // ever appears. /show-tools on: each distinct call gets its own
            // standalone message, name only, that is never edited/deleted.
            if (session.showTools) await send(telegramChatId, `⚙ ${name}`);
          }
          continue;
        }

        const usage = (chunk as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
          .usage_metadata;
        if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
        if (usage?.input_tokens !== undefined) inputTokens = usage.input_tokens;

        if (typeof chunk.content === "string" && chunk.content) finalText += chunk.content;
      }

      const pendingApproval = await getPendingApproval(graph, ultronChatId);
      if (pendingApproval) {
        const summary = pendingApproval.calls
          .map((c) => `• ${summarizeToolCall(c.name, JSON.stringify(c.args ?? {}))}`)
          .join("\n");
        await safeEditMessage(telegramChatId, placeholder.message_id, `Approval needed:\n${summary}`);
        // One decision for the whole batch — Telegram's inline-keyboard UI
        // doesn't lend itself to per-call approval the way the CLI's
        // y/n-per-call prompt or the web's approval block do; approve-all
        // or deny-all is the reasonable tradeoff here.
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${ultronChatId}`)
          .text("❌ Deny", `deny:${ultronChatId}`);
        await send(telegramChatId, "Approve these actions?", { reply_markup: keyboard });
        return { status: "approval" };
      }

      todos.completeAll(ultronChatId);
      const visibleText = stripThinking(finalText);
      await safeEditMessage(telegramChatId, placeholder.message_id, visibleText.trim() || "(empty reply)");
      if (visibleText.trim()) chatEvents.append(ultronChatId, "ai", "telegram", visibleText.trim());

      const elapsedSeconds = (Date.now() - turnStarted) / 1000;
      const generatedTokens = outputTokens ?? Math.max(1, Math.round(finalText.length / 4));
      recordUsage("chat", ultronChatId, config.nemotronModel, inputTokens ?? 0, generatedTokens, Math.round(elapsedSeconds * 1000));

      // A separate message, sent after the reply is already on screen —
      // not appended to it — per explicit request: the stats line is a
      // distinct piece of information, not part of the answer.
      if (session.verbose) {
        await send(
          telegramChatId,
          formatTurnStats({ model: config.nemotronModel, inputTokens: inputTokens ?? 0, outputTokens: generatedTokens, elapsedSeconds }),
        );
      }

      const humanText = humanTextFromInput(input);
      if (humanText && visibleText.trim()) void recordUserModelObservation(ultronChatId, humanText, visibleText);

      const exportedChat = chats.get(ultronChatId);
      if (exportedChat) void maybeExportChat(graph, exportedChat);

      return { status: "ok", finalText: visibleText };
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      await safeEditMessage(telegramChatId, placeholder.message_id, "[ultron] stopped.");
      return { status: "aborted" };
    }
    const message = err instanceof Error ? err.message : String(err);
    debugLog(`turn error chat=${ultronChatId} error=${message}`);
    await safeEditMessage(telegramChatId, placeholder.message_id, `[ultron] error: ${message}`);
    return { status: "aborted" };
  } finally {
    if (activeAborts.get(ultronChatId) === abortController) activeAborts.delete(ultronChatId);
  }
}

function goalStatusLine(goal: Goal | undefined): string {
  if (!goal || goal.status === "cleared") return "no active goal — /task goal, then send a message";
  const turns = `${goal.turnsUsed}/${goal.maxTurns} turns`;
  if (goal.status === "active") return `active (${turns}): ${goal.objective}`;
  if (goal.status === "paused") return `paused${goal.lastReason ? ` — ${goal.lastReason}` : ""} (${turns}): ${goal.objective}`;
  if (goal.status === "complete") return `done${goal.lastReason ? ` — ${goal.lastReason}` : ""}: ${goal.objective}`;
  return `${goal.status}: ${goal.objective}`;
}

// Public entry point: one turn, plus — if /task goal is active — the same
// judge-then-continue auto-continuation the CLI's driveGoalLoop runs,
// as a sequential loop of independent runSingleTurn calls (see that
// function's comment for why this can't be recursive).
async function runTurn(telegramChatId: number, ultronChatId: string, input: { messages: HumanMessage[] } | Command): Promise<void> {
  let outcome = await runSingleTurn(telegramChatId, ultronChatId, input);
  const session = getSession(ultronChatId);

  while (outcome.status === "ok" && session.taskMode === "goal") {
    const goal = goals.get(ultronChatId);
    if (!goal || goal.status !== "active") return;
    if (goal.turnsUsed >= goal.maxTurns) {
      goals.pause(ultronChatId, `turn budget (${goal.maxTurns}) exhausted`);
      await send(telegramChatId, `[ultron] goal paused — turn budget (${goal.maxTurns}) exhausted.`);
      return;
    }

    let verdict;
    try {
      verdict = await judgeGoal({ objective: goal.objective, finalMessage: outcome.finalText, codeContext: gatherCodeContext() });
    } catch (error) {
      goals.pause(ultronChatId, "goal check failed");
      await send(telegramChatId, `[ultron] goal paused — check failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (verdict.verdict === "done") {
      goals.markDone(ultronChatId, verdict.reason);
      await send(telegramChatId, `[ultron] goal complete — ${verdict.reason}`);
      return;
    }
    if (verdict.verdict === "blocked") {
      goals.pause(ultronChatId, verdict.reason);
      await send(telegramChatId, `[ultron] goal paused — ${verdict.reason}`);
      return;
    }

    goals.recordTurn(ultronChatId);
    await send(telegramChatId, `[ultron] goal continuing — ${verdict.reason}`);
    outcome = await runSingleTurn(telegramChatId, ultronChatId, {
      messages: [new HumanMessage(buildContinuationPrompt(goal.objective, verdict.reason))],
    });
  }
}

// Short-lived cache so inline-keyboard callback data can stay a small index
// instead of a full chat id (Telegram caps callback_data at 64 bytes, and
// chat ids/titles routinely exceed that combined).
const modelPickerCache = new Map<number, { id: string; provider: LlmProvider }[]>();

// ---- commands ----

const HELP_TEXT = `local commands
/help — show this help
/provider [nvidia|deepseek|groq|openai] — switch chat-completion provider (bare cycles)
/login openai — connect a ChatGPT account via device-code OAuth
/model [query] — search and select a model across NVIDIA, DeepSeek and Groq
/status — show provider, model, memory, tool and runtime status
/context — show current context usage
/stop — stop the active generation
/retry — remove the previous reply and run the last message again
/compact — summarize old messages and keep the recent turns
/think on|low|off — set reasoning mode
/task none|todo|plan|goal — set task mode (goal: next message becomes the objective)
/permissions — choose bypass, accept_edit or manual
/security bypass|accept_edit|manual — same, set directly
/verbose on|off — show model/tokens/time/cost after each reply
/show-tools on|off — off (default): tool calls stay silent, only the final reply shows; on: each tool call gets its own standalone message (name only)
/memory [clear|forget <id>] — list, clear, or remove auto-accumulated observations about you
/health — show the last 7 days of ingested health data
/export [path|on|off] — live-export this chat to a file, updated after every turn
/theme — not applicable here (no terminal to theme); accepted for parity, no-op
/quit — stop the ULTRON Telegram bot process`;

bot.command("help", async (ctx) => { await send(ctx.chat.id, HELP_TEXT); });

bot.command("start", async (ctx) => {
  currentChatId(ctx.chat.id);
  await send(ctx.chat.id, "Online. Send anything. /help for the full command list.");
});

bot.command("status", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const chat = chats.get(ultronChatId)!;
  const session = getSession(ultronChatId);
  const goal = goals.get(ultronChatId);
  await send(
    ctx.chat.id,
    [
      `provider: ${config.provider}`,
      `model: ${config.nemotronModel}`,
      `chat: ${ultronChatId}`,
      `tools: ${tools.length} available`,
      `think: ${session.thinkingMode}`,
      `task: ${session.taskMode}`,
      `security: ${chat.securityMode}`,
      `goal: ${goalStatusLine(goal)}`,
      `verbose: ${session.verbose ? "on" : "off"}`,
      `show-tools: ${session.showTools ? "on" : "off"}`,
      "status: ready",
    ].join("\n"),
  );
});

bot.command("context", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const usedTokens = await estimateContextUsage(graph, ultronChatId);
  const maxTokens = config.contextWindowTokens;
  const pct = Math.round(Math.min(usedTokens / maxTokens, 1) * 100);
  await send(ctx.chat.id, `context: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${pct}%)`);
});

bot.command("stop", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const controller = activeAborts.get(ultronChatId);
  if (!controller) {
    await send(ctx.chat.id, "[ultron] nothing running.");
    return;
  }
  controller.abort();
  await send(ctx.chat.id, "[ultron] stopping…");
});

bot.command("retry", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const retryInput = await prepareRetry(graph, ultronChatId);
  if (!retryInput) {
    await send(ctx.chat.id, "[ultron] nothing to retry yet.");
    return;
  }
  await runTurn(ctx.chat.id, ultronChatId, { messages: [new HumanMessage(retryInput)] });
});

bot.command("compact", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const result = await compactThread(graph, ultronChatId);
  await send(
    ctx.chat.id,
    result.compacted
      ? `[ultron] compacted ${result.before} messages into ${result.after} context messages.`
      : "[ultron] not enough history to compact yet.",
  );
});

bot.command("think", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const session = getSession(ultronChatId);
  const arg = ctx.match?.trim().toLowerCase();
  if (!arg) {
    await send(ctx.chat.id, `[ultron] reasoning mode: ${session.thinkingMode} (use /think on|low|off).`);
    return;
  }
  if (arg === "on" || arg === "full") session.thinkingMode = "full";
  else if (arg === "low") session.thinkingMode = "low";
  else if (arg === "off") session.thinkingMode = "off";
  else {
    await send(ctx.chat.id, "[ultron] use /think on, /think low or /think off.");
    return;
  }
  await send(ctx.chat.id, `[ultron] reasoning mode set to ${session.thinkingMode}.`);
});

bot.command("task", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const session = getSession(ultronChatId);
  const arg = ctx.match?.trim().toLowerCase();
  if (!arg) {
    await send(ctx.chat.id, `[ultron] task mode: ${session.taskMode} (use /task none|todo|plan|goal).`);
    return;
  }
  if (arg !== "none" && arg !== "todo" && arg !== "plan" && arg !== "goal") {
    await send(ctx.chat.id, "[ultron] use /task none, /task todo, /task plan or /task goal.");
    return;
  }
  session.taskMode = arg;
  // Same reset-at-selection rule as the CLI: dropping stale state at
  // mode-switch time so the next message can't be mistaken for the
  // continuation of an old plan/goal.
  if (arg === "todo" || arg === "plan") todos.clear(ultronChatId);
  if (arg !== "goal") goals.clear(ultronChatId);
  await send(ctx.chat.id, `[ultron] task mode set to ${session.taskMode}.`);
});

bot.command("security", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const arg = ctx.match?.trim().toLowerCase();
  if (!arg) {
    await send(ctx.chat.id, `[ultron] tool approval: ${chats.getSecurityMode(ultronChatId)} (use /security bypass|accept_edit|manual).`);
    return;
  }
  if (arg !== "bypass" && arg !== "accept_edit" && arg !== "manual") {
    await send(ctx.chat.id, "[ultron] use /security bypass, /security accept_edit or /security manual.");
    return;
  }
  chats.setSecurityMode(ultronChatId, arg);
  await send(ctx.chat.id, `[ultron] tool approval set to ${arg}.`);
});

bot.command("export", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const chat = chats.get(ultronChatId);
  if (!chat) return;
  const arg = ctx.match?.trim() ?? "";
  if (!arg) {
    await send(
      ctx.chat.id,
      chat.exportPath
        ? `[ultron] live export: ${chat.exportPath} (updates after every turn) — /export off to stop.`
        : "[ultron] no live export active for this chat — /export [path] to start, /export off to stop.",
    );
    return;
  }
  if (arg.toLowerCase() === "off") {
    chats.setExportPath(ultronChatId, null);
    await send(ctx.chat.id, "[ultron] live export stopped (file left as-is).");
    return;
  }
  const path = arg.toLowerCase() === "on" ? defaultExportPath(chat) : resolveExportPath(arg);
  chats.setExportPath(ultronChatId, path);
  await maybeExportChat(graph, { ...chat, exportPath: path });
  await send(ctx.chat.id, `[ultron] live export started: ${path} (updates after every turn).`);
});

bot.command("permissions", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const keyboard = new InlineKeyboard()
    .text("bypass", `security:${ultronChatId}:bypass`)
    .row()
    .text("accept_edit", `security:${ultronChatId}:accept_edit`)
    .row()
    .text("manual", `security:${ultronChatId}:manual`);
  await send(ctx.chat.id, `Current: ${chats.getSecurityMode(ultronChatId)}\nChoose tool approval:`, { reply_markup: keyboard });
});

bot.command("verbose", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const session = getSession(ultronChatId);
  const arg = ctx.match?.trim().toLowerCase();
  if (arg === "on" || arg === "true") session.verbose = true;
  else if (arg === "off" || arg === "false") session.verbose = false;
  else if (arg) {
    await send(ctx.chat.id, "[ultron] use /verbose on or /verbose off.");
    return;
  }
  await send(ctx.chat.id, `[ultron] verbose is ${session.verbose ? "on" : "off"}.`);
});

bot.command("memory", async (ctx) => {
  const arg = ctx.match?.trim().toLowerCase() ?? "";
  if (!arg) {
    const observations = userModel.list(30);
    if (!observations.length) {
      await send(ctx.chat.id, "[ultron] no observations accumulated yet.");
      return;
    }
    const lines = observations.map((o) => `#${o.id} (${o.category}) ${o.content}`).join("\n");
    await send(ctx.chat.id, `${userModel.count()} observation(s) — /memory clear or /memory forget <id>\n${lines}`);
    return;
  }
  if (arg === "clear") {
    userModel.clear();
    await send(ctx.chat.id, "[ultron] all accumulated observations cleared.");
    return;
  }
  if (arg.startsWith("forget ")) {
    const id = Number(arg.slice("forget ".length).trim());
    if (!Number.isInteger(id)) {
      await send(ctx.chat.id, "[ultron] use /memory forget <id> (see /memory for ids).");
      return;
    }
    userModel.remove(id);
    await send(ctx.chat.id, `[ultron] observation #${id} forgotten (if it existed).`);
    return;
  }
  await send(ctx.chat.id, "[ultron] use /memory, /memory clear or /memory forget <id>.");
});

bot.command("health", async (ctx) => {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const days = health.getRange(from, to);
  if (!days.length) {
    await send(ctx.chat.id, "[ultron] no health data ingested yet.");
    return;
  }
  const steps = sparkline(days.map((d) => d.steps));
  const lines = days
    .map((day) => {
      const parts: string[] = [];
      if (day.steps !== null) parts.push(`${day.steps} steps`);
      if (day.sleepDurationSec !== null) parts.push(`${(day.sleepDurationSec / 3600).toFixed(1)}h sleep`);
      if (day.restingHR !== null) parts.push(`resting HR ${day.restingHR}`);
      if (day.hrvAvg !== null) parts.push(`HRV ${day.hrvAvg}ms`);
      return `${day.date}: ${parts.length ? parts.join(", ") : "no data"}`;
    })
    .join("\n");
  const latest = pickLatestWithData(days)!;
  const getBaseline30 = (m: HealthMetric) => health.getBaseline(m, 30);
  const recovery = computeRecoveryScore(latest, getBaseline30);
  const activity = computeActivityScore(latest, getBaseline30);
  const anomalies = detectAnomalies(latest, getBaseline30);
  const records = health.getRecords();
  const scoreLine = `recovery ${recovery}/100, activity ${activity}/100, streak ${records.currentActivityStreakDays}d`;
  const anomalyLine = anomalies.length ? `\n⚠ ${anomalies[0].message}` : "";
  await send(ctx.chat.id, `[ultron] last 7 days — steps ${steps}\n${lines}\n${scoreLine}${anomalyLine}`);
});

// No terminal to theme here — accepted for command-set parity with the
// CLI, deliberately a no-op rather than pretending Telegram has a light/dark
// rendering mode of its own (that's controlled by the user's Telegram app,
// not by ULTRON).
bot.command("theme", async (ctx) => {
  await send(ctx.chat.id, "[ultron] not applicable in Telegram — theme is controlled by your Telegram app, not ULTRON.");
});

bot.command("model", async (ctx) => {
  const query = ctx.match?.trim().toLowerCase();
  await send(ctx.chat.id, "[ultron] loading models…");
  try {
    const groups = await listModelsByProvider();
    const flat = groups.flatMap((g) => g.models.map((m) => ({ id: m.id, provider: g.provider })));
    const matches = (query ? flat.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(query)) : flat)
      .filter((m) => `model:${m.id}`.length <= 64)
      .slice(0, 30);
    if (!matches.length) {
      await send(ctx.chat.id, "[ultron] no matching models.");
      return;
    }
    modelPickerCache.set(ctx.chat.id, matches);
    const keyboard = new InlineKeyboard();
    let lastProvider: LlmProvider | undefined;
    matches.forEach((m, i) => {
      if (m.provider !== lastProvider) {
        lastProvider = m.provider;
        keyboard.text(`── ${m.provider} ──`, "model:noop").row();
      }
      keyboard.text(m.id, `model:${i}`);
      keyboard.row();
    });
    await send(ctx.chat.id, `Current: ${config.provider}/${config.nemotronModel}\nSelect a model:`, { reply_markup: keyboard });
  } catch (error) {
    await send(ctx.chat.id, `[ultron] could not list models: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.command("provider", async (ctx) => {
  const requested = ctx.match?.trim().toLowerCase();
  let next: LlmProvider;
  if (requested === "nvidia" || requested === "deepseek" || requested === "groq" || requested === "openai") {
    next = requested;
  } else if (requested) {
    await send(ctx.chat.id, "[ultron] use /provider nvidia, /provider deepseek, /provider groq or /provider openai.");
    return;
  } else {
    next = nextConfiguredProvider(config.provider);
  }
  if (!hasProviderCredentials(next)) {
    const hint = next === "openai" ? 'not connected — run "/login openai" first' : `${next.toUpperCase()}_API_KEY is not set (see .env.example)`;
    await send(ctx.chat.id, `[ultron] ${hint} — cannot switch to ${next}.`);
    return;
  }
  setActiveProvider(next);
  graph = buildGraph();
  await send(ctx.chat.id, `[ultron] provider set to ${next} (model: ${config.nemotronModel}).`);
});

// /login openai — device-code OAuth against a ChatGPT account (see
// core/llm/openaiAuth.ts's header comment for the verified flow). A login
// is global (one ULTRON install, one ChatGPT account), not per-chat.
bot.command("login", async (ctx) => {
  const requested = ctx.match?.trim().toLowerCase();
  if (requested !== "openai") {
    await send(ctx.chat.id, "[ultron] use /login openai.");
    return;
  }
  try {
    const session = await requestDeviceCode();
    await send(ctx.chat.id, `[ultron] open ${session.verificationUrl} and enter code ${session.userCode} (expires in 15 min)…`);
    pollAndExchange(session)
      .then((tokens) => {
        const accountEmail = tokens.idToken ? decodeAccountEmail(tokens.idToken) : null;
        getOpenAIAuthRegistry(config.databasePath).save({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          accountEmail,
        });
        void send(ctx.chat.id, `[ultron] connected to ChatGPT${accountEmail ? ` as ${accountEmail}` : ""}. Try /provider openai.`);
      })
      .catch((err) => {
        void send(ctx.chat.id, `[ultron] ChatGPT login failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  } catch (error) {
    await send(ctx.chat.id, `[ultron] ChatGPT login failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

bot.command("quit", async (ctx) => {
  await send(ctx.chat.id, "[ultron] stopping the bot process.");
  debugLog(`stopping — /quit from chat=${ctx.chat.id}`);
  await bot.stop();
  process.exit(0);
});

// ---- callback queries (inline-keyboard follow-ups) ----

bot.callbackQuery(/^(approve|deny):(.+)$/, async (ctx) => {
  const [, decision, ultronChatId] = ctx.match as unknown as [string, string, string];
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});

  const pendingApproval = await getPendingApproval(graph, ultronChatId);
  if (!pendingApproval) {
    await send(ctx.chat!.id, "[ultron] nothing pending anymore.");
    return;
  }
  const decisions: ToolApprovalDecision = {};
  for (const call of pendingApproval.calls) decisions[call.id] = decision === "approve";
  await runTurn(ctx.chat!.id, ultronChatId, new Command({ resume: decisions }));
});

bot.callbackQuery(/^security:(.+):(bypass|accept_edit|manual)$/, async (ctx) => {
  const [, ultronChatId, mode] = ctx.match as unknown as [string, string, "bypass" | "accept_edit" | "manual"];
  await ctx.answerCallbackQuery();
  chats.setSecurityMode(ultronChatId, mode);
  await ctx.editMessageText(`[ultron] tool approval set to ${mode}.`).catch(() => {});
});

bot.callbackQuery("model:noop", async (ctx) => { await ctx.answerCallbackQuery(); });

bot.callbackQuery(/^model:(\d+)$/, async (ctx) => {
  const index = Number((ctx.match as unknown as [string, string])[1]);
  await ctx.answerCallbackQuery();
  const list = modelPickerCache.get(ctx.chat!.id);
  const choice = list?.[index];
  if (!choice) {
    await send(ctx.chat!.id, "[ultron] selection expired — run /model again.");
    return;
  }
  if (choice.provider !== config.provider) setActiveProvider(choice.provider);
  setActiveModel(choice.id);
  graph = buildGraph();
  await ctx.editMessageText(`[ultron] model set to ${choice.provider}/${choice.id}.`).catch(() => {});
});

// ---- meal/exercise photo logging ----

// Deliberately a side channel, not routed through the main agent turn: same
// shape as POST /api/health-data/ingest (a direct write to the health
// store, not a tool call the model reasons about) rather than threading
// multimodal messages through the LangGraph state, which none of the three
// interfaces support yet.
bot.on("message:photo", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  chats.setFocus(ultronChatId, `telegram:${ctx.chat.id}`);
  await ctx.replyWithChatAction("upload_photo").catch(() => {});

  const caption = ctx.message.caption;
  const largest = ctx.message.photo[ctx.message.photo.length - 1];
  try {
    const file = await ctx.api.getFile(largest.file_id);
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const response = await fetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`);
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
    const base64 = buffer.toString("base64");

    const analysis = await analyzeHealthPhoto(base64, mimeType, caption);
    const date = new Date().toISOString().slice(0, 10);
    const timestamp = new Date().toISOString();

    if (analysis.kind === "unrecognized") {
      await send(ctx.chat.id, `[ultron] Couldn't tell this was a meal or exercise photo: ${analysis.description}`);
      return;
    }

    const photoPath = savePhoto(buffer, mimeType, analysis.kind, date);
    if (analysis.kind === "meal") {
      mealExerciseLog.addMeal({
        date,
        timestamp,
        photoPath,
        caption: caption ?? null,
        description: analysis.description,
        estimatedCalories: analysis.estimatedCalories,
        proteinG: analysis.proteinG,
        carbsG: analysis.carbsG,
        fatG: analysis.fatG,
        sourceChatId: ultronChatId,
      });
      const macros = [
        analysis.estimatedCalories !== null ? `~${analysis.estimatedCalories} kcal` : undefined,
        analysis.proteinG !== null ? `${analysis.proteinG}g protein` : undefined,
        analysis.carbsG !== null ? `${analysis.carbsG}g carbs` : undefined,
        analysis.fatG !== null ? `${analysis.fatG}g fat` : undefined,
      ].filter((x) => x !== undefined);
      const fallback = `Meal logged: ${analysis.description}${macros.length ? ` (${macros.join(", ")})` : ""}`;
      const reply = await narrateLoggedEntry("meal", analysis, caption ?? null).catch(() => fallback);
      await send(ctx.chat.id, reply);
    } else {
      mealExerciseLog.addExercise({
        date,
        timestamp,
        photoPath,
        caption: caption ?? null,
        description: analysis.description,
        exerciseType: analysis.exerciseType,
        durationMinutes: analysis.durationMinutes,
        intensity: analysis.intensity,
        estimatedCaloriesBurned: analysis.estimatedCaloriesBurned,
        sourceChatId: ultronChatId,
      });
      const details = [
        analysis.exerciseType ?? undefined,
        analysis.durationMinutes !== null ? `${analysis.durationMinutes} min` : undefined,
        analysis.intensity ?? undefined,
        analysis.estimatedCaloriesBurned !== null ? `~${analysis.estimatedCaloriesBurned} kcal burned` : undefined,
      ].filter((x) => x !== undefined);
      const fallback = `Exercise logged: ${analysis.description}${details.length ? ` (${details.join(", ")})` : ""}`;
      const reply = await narrateLoggedEntry("exercise", analysis, caption ?? null).catch(() => fallback);
      await send(ctx.chat.id, reply);
    }
  } catch (err) {
    debugLog(`photo analysis failed chat=${ctx.chat.id} error=${err instanceof Error ? err.message : String(err)}`);
    await send(ctx.chat.id, "[ultron] Couldn't analyze that photo — try again?");
  }
});

// ---- plain messages ----

// grammY's bot.command() only matches Telegram's "bot_command" message
// entity, which requires [a-zA-Z0-9_] — a hyphen (as in "/show-tools")
// never registers as one, so it's handled here as plain text instead of a
// bot.command("show_tools", ...) handler that would simply never fire.
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  if (text.toLowerCase().startsWith("/show-tools")) {
    const ultronChatId = currentChatId(ctx.chat.id);
    const session = getSession(ultronChatId);
    const arg = text.slice("/show-tools".length).trim().toLowerCase();
    if (!arg) {
      await send(ctx.chat.id, `[ultron] show-tools: ${session.showTools ? "on" : "off"} (use /show-tools on or /show-tools off).`);
      return;
    }
    if (arg === "on" || arg === "true") session.showTools = true;
    else if (arg === "off" || arg === "false") session.showTools = false;
    else {
      await send(ctx.chat.id, "[ultron] use /show-tools on or /show-tools off.");
      return;
    }
    await send(ctx.chat.id, `[ultron] show-tools ${session.showTools ? "on" : "off"}.`);
    return;
  }
  if (text.startsWith("/")) return;

  const ultronChatId = currentChatId(ctx.chat.id);
  const session = getSession(ultronChatId);
  chats.setFocus(ultronChatId, `telegram:${ctx.chat.id}`);
  chatEvents.append(ultronChatId, "human", "telegram", text);
  autoTitleChat(chats, ultronChatId, text);
  chats.touch(ultronChatId);

  // Same as the CLI/web: selecting "goal" mode just arms it, and the next
  // non-retry message sent becomes the objective — every message while
  // armed overwrites whatever goal existed before (goals.set()).
  if (session.taskMode === "goal") {
    goals.set(ultronChatId, text, config.goalMaxTurns);
    await send(ctx.chat.id, `[ultron] goal: ${text} (self-checking after each turn, max ${config.goalMaxTurns})`);
  }

  await ctx.replyWithChatAction("typing").catch(() => {});
  await runTurn(ctx.chat.id, ultronChatId, { messages: [new HumanMessage(text)] });
});

bot.catch((err) => {
  debugLog(`unhandled error chat=${err.ctx.chat?.id ?? "unknown"} error=${err.error instanceof Error ? err.error.message : String(err.error)}`);
});

process.once("SIGINT", () => { void bot.stop(); });
process.once("SIGTERM", () => { void bot.stop(); });

bot.start();
debugLog("started (long polling)");
