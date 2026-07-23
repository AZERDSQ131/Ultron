import { config as appConfig } from "../config.js";
import { createNemotronModel } from "./llm/nemotron.js";
import { recordUsage } from "./llm/usage.js";
import { DEFAULT_CHAT_TITLE, deriveTitle, type ChatRegistry } from "./memory/chats.js";
import { log } from "./logger.js";

// Every new chat starts titled "New chat" until its first real message.
// deriveTitle's plain truncation used to be the permanent title; now it's
// only the instant placeholder shown while a separate, cheap LLM call (same
// pattern as goalJudge.ts/userModelExtractor.ts) produces a real short
// title, the way ChatGPT/Claude auto-title a thread instead of just
// echoing back the first line the user typed.

const MAX_MESSAGE_CHARS = 2000;

const TITLE_SYSTEM_PROMPT = `Reply with only a short conversation title (3 to 6 words) summarizing the user's message below — no quotes, no trailing punctuation, no preamble like "Title:". Nothing else.`;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
}

function sanitizeTitle(raw: string): string | null {
  const title = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!]+$/, "")
    .trim();
  return title.length > 0 && title.length <= 80 ? title : null;
}

export async function generateChatTitle(text: string, chatId: string | null = null): Promise<string | null> {
  const model = createNemotronModel("low");
  const started = Date.now();
  const response = await model.invoke([
    { role: "system" as const, content: TITLE_SYSTEM_PROMPT },
    { role: "user" as const, content: truncate(text.trim(), MAX_MESSAGE_CHARS) },
  ]);
  recordUsage("chat_title", chatId, appConfig.nemotronModel, response.usage_metadata?.input_tokens ?? 0, response.usage_metadata?.output_tokens ?? 0, Date.now() - started);
  const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  return sanitizeTitle(raw);
}

// Called with the first human message of a chat. Sets an instant
// deterministic placeholder (deriveTitle) so the chat list never shows
// "New chat" for long, then fires the real LLM title generation in the
// background and overwrites it once it resolves — never awaited by the
// calling turn, any failure just leaves the placeholder title in place.
export function autoTitleChat(chats: ChatRegistry, chatId: string, text: string): void {
  const chat = chats.get(chatId);
  if (!chat || chat.title !== DEFAULT_CHAT_TITLE) return;
  const placeholder = deriveTitle(text);
  chats.rename(chatId, placeholder);
  void generateChatTitle(text, chatId)
    .then((title) => {
      if (!title) return;
      // Only overwrite if the title is still our own placeholder — never
      // clobber a title the user (or anything else) already changed.
      const current = chats.get(chatId);
      if (current && current.title === placeholder) chats.rename(chatId, title);
    })
    .catch((err) => {
      log("chat-title", `generation failed chat=${chatId} error=${err instanceof Error ? err.message : String(err)}`);
    });
}
