import { Bot, InlineKeyboard } from "grammy";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { config } from "../../config.js";
import {
  buildGraph,
  clearThreadMessages,
  compactThread,
  estimateContextUsage,
  getPendingApproval,
  listChatMessages,
  prepareRetry,
  type TaskMode,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { markdownToTelegramHtml } from "./format.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { formatTurnStats } from "../../core/llm/usage.js";
import { recordUserModelObservation } from "../../core/userModelExtractor.js";
import { getUserModelRegistry } from "../../core/memory/userModel.js";
import { DEFAULT_CHAT_TITLE, getChatRegistry, LEGACY_CHAT_ID, type Chat } from "../../core/memory/chats.js";
import { defaultExportPath, maybeExportChat, resolveExportPath } from "../../core/memory/exporter.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { getGoalRegistry, type Goal } from "../../core/memory/goals.js";
import { getTelegramLinkRegistry } from "../../core/memory/telegramLinks.js";
import { buildContinuationPrompt, gatherCodeContext, judgeGoal } from "../../core/goalJudge.js";
import { tools } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
import { withThreadLock } from "../../core/threadLock.js";
import { log } from "../../core/logger.js";

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
const links = getTelegramLinkRegistry(config.databasePath);

// Ensures pre-existing history from the CLI's original hardcoded thread
// registers as a real chat — same migration every entry point does at
// startup (see chats.ts's LEGACY_CHAT_ID comment).
chats.ensure(LEGACY_CHAT_ID);

// Which ULTRON chat a Telegram chat currently points at is a movable
// pointer (TelegramLinkRegistry), not a fixed derivation — /archive and
// /resume both repoint it. On first contact from a given Telegram chat,
// adopt `telegram-<id>` if it already has history (an earlier version of
// this file derived the id that way with no indirection), otherwise start
// a brand-new chat.
function currentChatId(telegramChatId: number): string {
  const linked = links.get(telegramChatId);
  if (linked && chats.get(linked)) return linked;
  const legacyDerived = `telegram-${telegramChatId}`;
  const chat = chats.get(legacyDerived) ?? chats.create(DEFAULT_CHAT_TITLE);
  links.set(telegramChatId, chat.id);
  return chat.id;
}

// Per-chat session state that has no natural persistence slot elsewhere
// (unlike security mode, which lives on the Chat row itself) — mirrors the
// CLI's process-local `thinkingMode`/`taskMode`/`verbose` variables. Reset
// on bot restart, same as the CLI resets on process restart.
interface Session {
  thinkingMode: ThinkingMode;
  taskMode: TaskMode;
  verbose: boolean;
}
const sessions = new Map<string, Session>();
function getSession(ultronChatId: string): Session {
  let session = sessions.get(ultronChatId);
  if (!session) {
    session = { thinkingMode: "full", taskMode: "none", verbose: false };
    sessions.set(ultronChatId, session);
  }
  return session;
}

// Tracks message ids ULTRON has sent into each Telegram chat, purely so
// /clear has something to actually delete (see its handler) — Telegram
// gives bots no "clear this chat" API, only per-message deletion, and only
// for messages up to ~48h old.
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
            await safeEditMessage(telegramChatId, placeholder.message_id, `⚙ ${name}…`);
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

      // A separate message, sent after the reply is already on screen —
      // not appended to it — per explicit request: the stats line is a
      // distinct piece of information, not part of the answer.
      if (session.verbose) {
        const elapsedSeconds = (Date.now() - turnStarted) / 1000;
        const generatedTokens = outputTokens ?? Math.max(1, Math.round(finalText.length / 4));
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

// How many of the most recent ULTRON replies to preview right after
// resuming — enough to remind the user where the conversation left off
// without dumping the whole history into the chat. Only ULTRON's own
// replies are replayed, one per Telegram message: the Bot API has no way
// to send a message that appears as coming from the real user account, so
// echoing the user's own past messages back through the bot would just be
// misleading, especially for a chat that was actually typed on a different
// interface (CLI/web) in the first place — those were never real Telegram
// messages to begin with.
const RESUME_PREVIEW_MESSAGES = 3;

// Resuming an archived chat unarchives it (chats.unarchive) and repoints
// this Telegram chat's link at it — its LangGraph checkpoint state was
// never touched by archiving, so this is a real resume, not a text
// reconstruction (the old .txt-export mechanism this replaced only carried
// human/ai text and lost tool-call context). Unlike the CLI/web, which
// redraw the whole thread on resume, Telegram has no persistent scrollback
// to fall back on — without a preview here, "resumed" told the user
// nothing about what they were actually resuming.
async function resumeInto(telegramChatId: number, chat: Chat): Promise<void> {
  chats.unarchive(chat.id);
  links.set(telegramChatId, chat.id);
  await send(telegramChatId, `[ultron] resumed "${chat.title}".`);
  const messages = await listChatMessages(graph, chat.id);
  const recent = messages.filter((m) => m.role === "ai").slice(-RESUME_PREVIEW_MESSAGES);
  for (const message of recent) await send(telegramChatId, message.content);
}

// Short-lived cache so inline-keyboard callback data can stay a small index
// instead of a full chat id (Telegram caps callback_data at 64 bytes, and
// chat ids/titles routinely exceed that combined).
const archivePickerCache = new Map<number, Chat[]>();
const modelPickerCache = new Map<number, string[]>();

// ---- commands ----

const HELP_TEXT = `local commands
/help — show this help
/model [query] — search and select an NVIDIA model
/status — show model, memory, tool and runtime status
/context — show current context usage
/stop — stop the active generation
/retry — remove the previous reply and run the last message again
/compact — summarize old messages and keep the recent turns
/archive [title] — rename (optional), archive this conversation and start a new one
/resume [query] — reopen an archived conversation with its full context; no query lists them with buttons to open or delete
/think on|low|off — set reasoning mode
/task none|todo|plan|goal — set task mode (goal: next message becomes the objective)
/permissions — choose bypass, accept_edit or manual
/security bypass|accept_edit|manual — same, set directly
/verbose on|off — show model/tokens/time/cost after each reply
/memory [clear|forget <id>] — list, clear, or remove auto-accumulated observations about you
/export [path|on|off] — live-export this chat to a file, updated after every turn
/clear — wipe this conversation's memory and delete what ULTRON can of its own recent messages here (Telegram limits bot deletions to ~48h, own messages only)
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
      `model: ${config.nemotronModel}`,
      `chat: ${ultronChatId}`,
      `tools: ${tools.length} available`,
      `think: ${session.thinkingMode}`,
      `task: ${session.taskMode}`,
      `security: ${chat.securityMode}`,
      `goal: ${goalStatusLine(goal)}`,
      `verbose: ${session.verbose ? "on" : "off"}`,
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

bot.command("archive", async (ctx) => {
  const ultronChatId = currentChatId(ctx.chat.id);
  const title = ctx.match?.trim();
  const archived = chats.archive(ultronChatId, title || undefined);
  const fresh = chats.create();
  links.set(ctx.chat.id, fresh.id);
  await send(ctx.chat.id, `[ultron] archived "${archived?.title ?? title ?? ""}". Started a new chat.`);
});

bot.command("resume", async (ctx) => {
  const query = ctx.match?.trim();
  const archived = chats.listArchived();
  if (!archived.length) {
    await send(ctx.chat.id, "[ultron] no archived chats.");
    return;
  }
  if (query) {
    const match = archived.find((c) => c.id === query || c.title.toLowerCase().includes(query.toLowerCase()));
    if (!match) {
      await send(ctx.chat.id, `[ultron] no archived chat matches "${query}".`);
      return;
    }
    await resumeInto(ctx.chat.id, match);
    return;
  }
  const top = archived.slice(0, 20);
  archivePickerCache.set(ctx.chat.id, top);
  const keyboard = new InlineKeyboard();
  top.forEach((c, i) => {
    keyboard.text(`▶ ${c.title.slice(0, 50) || "(untitled)"}`, `resume_open:${i}`);
    keyboard.text("🗑", `resume_del:${i}`);
    keyboard.row();
  });
  await send(ctx.chat.id, "Archived chats:", { reply_markup: keyboard });
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

// No terminal to theme here — accepted for command-set parity with the
// CLI, deliberately a no-op rather than pretending Telegram has a light/dark
// rendering mode of its own (that's controlled by the user's Telegram app,
// not by ULTRON).
bot.command("theme", async (ctx) => {
  await send(ctx.chat.id, "[ultron] not applicable in Telegram — theme is controlled by your Telegram app, not ULTRON.");
});

bot.command("model", async (ctx) => {
  const query = ctx.match?.trim().toLowerCase();
  await send(ctx.chat.id, "[ultron] loading NVIDIA models…");
  try {
    const baseUrl = config.nemotronBaseUrl.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${config.nvidiaApiKey}` },
    });
    if (!response.ok) throw new Error(`NVIDIA returned HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = (payload.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : undefined))
      .filter((id): id is string => Boolean(id))
      .sort();
    const matches = (query ? ids.filter((id) => id.toLowerCase().includes(query)) : ids)
      .filter((id) => `model:${id}`.length <= 64)
      .slice(0, 20);
    if (!matches.length) {
      await send(ctx.chat.id, "[ultron] no matching models.");
      return;
    }
    modelPickerCache.set(ctx.chat.id, matches);
    const keyboard = new InlineKeyboard();
    matches.forEach((id, i) => {
      keyboard.text(id, `model:${i}`);
      keyboard.row();
    });
    await send(ctx.chat.id, `Current: ${config.nemotronModel}\nSelect a model:`, { reply_markup: keyboard });
  } catch (error) {
    await send(ctx.chat.id, `[ultron] could not list NVIDIA models: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// Best-effort "clear the screen": deletes what ULTRON can of its own
// recently sent messages in this chat. Telegram bots cannot delete the
// other party's messages in a private chat, and cannot delete any message
// older than ~48h — a genuine terminal-style clear isn't possible here, this
// is the closest real equivalent rather than a silent no-op.
bot.command("clear", async (ctx) => {
  // Unlike the CLI/web, where /clear only redraws the terminal (the
  // scrollback is still visible, so the user can see for themselves that
  // history persists), Telegram shows no such reminder — a user typing
  // /clear here reasonably means "forget this conversation", not just
  // "tidy up my screen". Confirmed by a real report: saying "Salut" after
  // /clear got a reply that referenced the pre-clear greeting, because only
  // the visible messages were being touched, not the model's actual memory
  // of the thread. So /clear now wipes the thread's message state too, on
  // top of deleting what Telegram lets a bot delete of its own messages.
  const ultronChatId = currentChatId(ctx.chat.id);
  await clearThreadMessages(graph, ultronChatId);

  const ids = sentMessageIds.get(ctx.chat.id) ?? [];
  sentMessageIds.delete(ctx.chat.id);
  let deleted = 0;
  for (const id of ids) {
    try {
      await bot.api.deleteMessage(ctx.chat.id, id);
      deleted++;
    } catch {
      // Too old (>48h) or already gone — nothing to do.
    }
  }
  await send(
    ctx.chat.id,
    `[ultron] conversation memory cleared. Deleted ${deleted}/${ids.length} of my own recent message(s) too (Telegram limits bot deletions to ~48h, own messages only).`,
  );
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

bot.callbackQuery(/^resume_open:(\d+)$/, async (ctx) => {
  const index = Number((ctx.match as unknown as [string, string])[1]);
  await ctx.answerCallbackQuery();
  const list = archivePickerCache.get(ctx.chat!.id);
  const entry = list?.[index];
  if (!entry) {
    await send(ctx.chat!.id, "[ultron] selection expired — run /resume again.");
    return;
  }
  await ctx.editMessageText(`[ultron] resuming "${entry.title}"…`).catch(() => {});
  await resumeInto(ctx.chat!.id, entry);
});

// Delete goes through a one-tap confirm step (editing the same message with
// Yes/No) rather than deleting immediately — unlike resuming, this is
// destructive and can't be undone (chats.delete purges the checkpoint too).
bot.callbackQuery(/^resume_del:(\d+)$/, async (ctx) => {
  const index = Number((ctx.match as unknown as [string, string])[1]);
  await ctx.answerCallbackQuery();
  const list = archivePickerCache.get(ctx.chat!.id);
  const entry = list?.[index];
  if (!entry) {
    await send(ctx.chat!.id, "[ultron] selection expired — run /resume again.");
    return;
  }
  const keyboard = new InlineKeyboard()
    .text("Yes, delete", `resume_del_yes:${index}`)
    .text("Cancel", `resume_del_no:${index}`);
  await ctx.editMessageText(`Delete "${entry.title}" permanently?`, { reply_markup: keyboard }).catch(() => {});
});

bot.callbackQuery(/^resume_del_yes:(\d+)$/, async (ctx) => {
  const index = Number((ctx.match as unknown as [string, string])[1]);
  await ctx.answerCallbackQuery();
  const list = archivePickerCache.get(ctx.chat!.id);
  const entry = list?.[index];
  if (!entry) {
    await send(ctx.chat!.id, "[ultron] selection expired — run /resume again.");
    return;
  }
  chats.delete(entry.id);
  await ctx.editMessageText(`[ultron] deleted "${entry.title}".`).catch(() => {});
});

bot.callbackQuery(/^resume_del_no:(\d+)$/, async (ctx) => {
  const index = Number((ctx.match as unknown as [string, string])[1]);
  await ctx.answerCallbackQuery();
  const list = archivePickerCache.get(ctx.chat!.id);
  const entry = list?.[index];
  await ctx.editMessageText(entry ? `[ultron] kept "${entry.title}".` : "[ultron] cancelled.").catch(() => {});
});

bot.callbackQuery(/^model:(\d+)$/, async (ctx) => {
  const index = Number((ctx.match as unknown as [string, string])[1]);
  await ctx.answerCallbackQuery();
  const list = modelPickerCache.get(ctx.chat!.id);
  const id = list?.[index];
  if (!id) {
    await send(ctx.chat!.id, "[ultron] selection expired — run /model again.");
    return;
  }
  config.nemotronModel = id;
  graph = buildGraph();
  await ctx.editMessageText(`[ultron] model set to ${id}.`).catch(() => {});
});

// ---- plain messages ----

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return;

  const ultronChatId = currentChatId(ctx.chat.id);
  const session = getSession(ultronChatId);
  chats.maybeAutoTitle(ultronChatId, text);
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
