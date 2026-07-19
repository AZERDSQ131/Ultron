import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { listChatMessages, type ChatMessage } from "../graph.js";
import type { Chat } from "./chats.js";
import { config } from "../../config.js";

// Live conversation export: a chat can have a file path attached
// (Chat.exportPath, see chats.ts) that gets rewritten in full after every
// turn (see the executeTurn/streamGraphTurn/runSingleTurn call sites) —
// not a one-shot dump. Several chats can each have their own export active
// at once without clobbering each other, since the path is per-chat and
// defaults to a name that includes the chat id.

const EXPORTS_DIR = join(dirname(config.databasePath), "exports");

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "chat";
}

// Called with no explicit path (bare "/export") to pick a default that
// won't collide with another chat's export even if the titles match.
export function defaultExportPath(chat: Chat): string {
  return join(EXPORTS_DIR, `${slugify(chat.title)}-${chat.id.slice(0, 8)}.md`);
}

export function resolveExportPath(path: string): string {
  return isAbsolute(path) ? path : join(EXPORTS_DIR, path);
}

function formatMarkdown(chat: Chat, messages: ChatMessage[]): string {
  const lines = [`# ${chat.title}`, "", `_chat ${chat.id} — exported ${new Date().toISOString()}_`, ""];
  for (const message of messages) {
    if (message.role === "human") lines.push("## You", "", message.content, "");
    else if (message.role === "ai") lines.push("## ULTRON", "", message.content, "");
    else if (message.role === "tool_call") lines.push(`_→ tool call: ${message.name ?? "tool"}_`, "", "```", message.content, "```", "");
    else lines.push(`_← tool result: ${message.name ?? "tool"}_`, "", "```", message.content, "```", "");
  }
  return lines.join("\n");
}

// Writes the file atomically (tmp + rename) so a reader (e.g. an editor
// with the file open) never sees a half-written export mid-turn.
export async function writeExport(graph: Parameters<typeof listChatMessages>[0], chat: Chat, path: string): Promise<void> {
  const messages = await listChatMessages(graph, chat.id);
  const content = formatMarkdown(chat, messages);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, path);
}

// Called from every turn-completion hook (CLI, web, Telegram) — a no-op if
// the chat has no export path set, so it's safe to call unconditionally.
export async function maybeExportChat(graph: Parameters<typeof listChatMessages>[0], chat: Chat): Promise<void> {
  if (!chat.exportPath) return;
  await writeExport(graph, chat, chat.exportPath);
}
