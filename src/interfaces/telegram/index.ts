import { Bot, InlineKeyboard } from "grammy";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { config } from "../../config.js";
import {
  buildGraph,
  getPendingApproval,
  type TaskMode,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { getChatRegistry, LEGACY_CHAT_ID } from "../../core/memory/chats.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { recordUserModelObservation } from "../../core/userModelExtractor.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
import { withThreadLock } from "../../core/threadLock.js";
import { log } from "../../core/logger.js";

// Third entry point alongside the CLI and the web UI (see CLAUDE.md's
// "Interface" decision) — same buildGraph(), same shared SQLite file, so a
// Telegram conversation shares memory, tools and personality with the other
// two. It does NOT get its own chat-switching UI: a Telegram chat is a
// single, fixed conversation with one person, so each Telegram chat id maps
// to exactly one ULTRON chat id, permanently — `telegram-<telegramChatId>`,
// registered through the same ChatRegistry.ensure() the CLI uses for its
// legacy thread, so it shows up in the web sidebar too.
//
// Deliberately minimal command set for v1 (/start, /status, /stop) — no
// /task, /security, /theme, /memory, /think here yet. Add them if actually
// needed; nothing here is designed to make that harder later, but building
// them unasked isn't the point of this pass.

function debugLog(message: string): void {
  log("telegram", message);
}

if (!config.telegramBotToken) {
  throw new Error("Missing environment variable: TELEGRAM_BOT_TOKEN (see .env.example)");
}

const bot = new Bot(config.telegramBotToken);
const graph = buildGraph();
const chats = getChatRegistry(config.databasePath);
const todos = getTodoRegistry(config.databasePath);

// Ensures pre-existing history from the CLI's original hardcoded thread
// registers as a real chat — same migration every entry point does at
// startup (see chats.ts's LEGACY_CHAT_ID comment).
chats.ensure(LEGACY_CHAT_ID);

function ultronChatIdFor(telegramChatId: number): string {
  return `telegram-${telegramChatId}`;
}

const activeAborts = new Map<string, AbortController>();

// Telegram rate-limits editMessageText; editing on every streamed token the
// way the CLI/web do would trip that almost immediately. Instead: one
// placeholder message per turn, updated only when the *tool name* changes
// (a coarse "what's it doing" indicator) and once more with the final text
// — cheap enough to never hit a limit, and edits Telegram silently 400s on
// (content unchanged) are swallowed rather than logged as real errors.
async function safeEditMessage(chatId: number, messageId: number, text: string): Promise<void> {
  try {
    await bot.api.editMessageText(chatId, messageId, text.slice(0, 4096) || "(empty reply)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("message is not modified")) debugLog(`edit failed chat=${chatId} error=${message}`);
  }
}

function humanTextFromInput(input: { messages: HumanMessage[] } | Command): string | undefined {
  if (!("messages" in input)) return undefined;
  const text = input.messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
    .trim();
  return text || undefined;
}

async function runTurn(telegramChatId: number, ultronChatId: string, input: { messages: HumanMessage[] } | Command): Promise<void> {
  activeAborts.get(ultronChatId)?.abort();
  const abortController = new AbortController();
  activeAborts.set(ultronChatId, abortController);

  const placeholder = await bot.api.sendMessage(telegramChatId, "…");
  let finalText = "";
  let lastToolName: string | undefined;

  try {
    await withThreadLock(ultronChatId, async () => {
      const stream = await graph.stream(input, {
        configurable: { thread_id: ultronChatId, thinking: "full", taskMode: "none" as TaskMode },
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

        if (typeof chunk.content === "string" && chunk.content) finalText += chunk.content;
      }

      const pendingApproval = await getPendingApproval(graph, ultronChatId);
      if (pendingApproval) {
        const summary = pendingApproval.calls
          .map((c) => `• ${summarizeToolCall(c.name, JSON.stringify(c.args ?? {}))}`)
          .join("\n");
        await safeEditMessage(telegramChatId, placeholder.message_id, `Approval needed:\n${summary}`);
        const keyboard = new InlineKeyboard()
          .text("✅ Approve", `approve:${ultronChatId}`)
          .text("❌ Deny", `deny:${ultronChatId}`);
        // One decision for the whole batch — Telegram's inline-keyboard UI
        // doesn't lend itself to per-call approval the way the CLI's
        // y/n-per-call prompt or the web's approval block do; a coarse
        // approve-all/deny-all is the reasonable v1 tradeoff here.
        await bot.api.sendMessage(telegramChatId, "Approve these actions?", { reply_markup: keyboard });
        return;
      }

      todos.completeAll(ultronChatId);
      await safeEditMessage(telegramChatId, placeholder.message_id, finalText.trim());

      const humanText = humanTextFromInput(input);
      if (humanText && finalText.trim()) void recordUserModelObservation(ultronChatId, humanText, finalText);
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      await safeEditMessage(telegramChatId, placeholder.message_id, "[ultron] stopped.");
    } else {
      const message = err instanceof Error ? err.message : String(err);
      debugLog(`turn error chat=${ultronChatId} error=${message}`);
      await safeEditMessage(telegramChatId, placeholder.message_id, `[ultron] error: ${message}`);
    }
  } finally {
    if (activeAborts.get(ultronChatId) === abortController) activeAborts.delete(ultronChatId);
  }
}

bot.command("start", async (ctx) => {
  const ultronChatId = ultronChatIdFor(ctx.chat.id);
  chats.ensure(ultronChatId);
  await ctx.reply("Online. Send anything.");
});

bot.command("status", async (ctx) => {
  const ultronChatId = ultronChatIdFor(ctx.chat.id);
  const chat = chats.ensure(ultronChatId);
  await ctx.reply(
    `model: ${config.nemotronModel}\nchat: ${ultronChatId}\nsecurity: ${chat.securityMode}\nstatus: ready`,
  );
});

bot.command("stop", async (ctx) => {
  const ultronChatId = ultronChatIdFor(ctx.chat.id);
  const controller = activeAborts.get(ultronChatId);
  if (!controller) {
    await ctx.reply("[ultron] nothing running.");
    return;
  }
  controller.abort();
  await ctx.reply("[ultron] stopping…");
});

bot.callbackQuery(/^(approve|deny):(.+)$/, async (ctx) => {
  const [, decision, ultronChatId] = ctx.match as unknown as [string, string, string];
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  const pendingApproval = await getPendingApproval(graph, ultronChatId);
  if (!pendingApproval) {
    await ctx.reply("[ultron] nothing pending anymore.");
    return;
  }
  const decisions: ToolApprovalDecision = {};
  for (const call of pendingApproval.calls) decisions[call.id] = decision === "approve";
  await runTurn(ctx.chat!.id, ultronChatId, new Command({ resume: decisions }));
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return;

  const ultronChatId = ultronChatIdFor(ctx.chat.id);
  chats.ensure(ultronChatId);
  chats.maybeAutoTitle(ultronChatId, text);
  chats.touch(ultronChatId);

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
