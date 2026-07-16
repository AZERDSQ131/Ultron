import { createReadStream, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HumanMessage } from "@langchain/core/messages";
import {
  archiveThread,
  buildGraph,
  compactThread,
  estimateContextUsage,
  listChatMessages,
  prepareRetry,
  resumeThread,
} from "../../core/graph.js";
import { config } from "../../config.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { getChatRegistry, LEGACY_CHAT_ID } from "../../core/memory/chats.js";
import { tools } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const graph = buildGraph();
const chats = getChatRegistry(config.databasePath);
// Migrates the CLI's original hardcoded thread ("ultron-main", used before
// chats existed) into the registry on first run, so pre-existing history
// shows up as a chat instead of being orphaned.
chats.ensure(LEGACY_CHAT_ID);

// One AbortController per chat, so stopping or starting a generation in one
// chat can't affect another that happens to also be streaming (e.g. the CLI
// generating on a different chat at the same time).
const activeAborts = new Map<string, AbortController>();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T | undefined> {
  const raw = await readBody(req);
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const pathname = url.split("?")[0];
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) return false;

  const type = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
  return true;
}

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function requireChat(res: ServerResponse, chatId: unknown): chatId is string {
  if (typeof chatId !== "string" || !chatId || !chats.get(chatId)) {
    sendJson(res, 404, { error: "unknown chat" });
    return false;
  }
  return true;
}

async function handleListChats(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { chats: chats.list() });
}

async function handleCreateChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ title?: string }>(req);
  if (!payload) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const chat = chats.create(payload.title?.trim() || undefined);
  sendJson(res, 200, { chat });
}

async function handleRenameChat(req: IncomingMessage, res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const payload = await readJson<{ title?: string }>(req);
  if (!payload?.title?.trim()) {
    sendJson(res, 400, { error: "title is required" });
    return;
  }
  chats.rename(chatId, payload.title.trim());
  sendJson(res, 200, { chat: chats.get(chatId) });
}

async function handleDeleteChat(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  activeAborts.get(chatId)?.abort();
  chats.delete(chatId);
  sendJson(res, 200, { deleted: true });
}

async function handleChatMessages(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const messages = await listChatMessages(graph, chatId);
  sendJson(res, 200, { messages });
}

async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; text?: string; thinking?: ThinkingMode; retry?: boolean }>(req);
  if (!payload) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (!requireChat(res, payload.chatId)) return;
  const chatId = payload.chatId as string;

  const thinkingMode: ThinkingMode = payload.thinking ?? "full";
  const isRetry = payload.retry === true;
  let input = payload.text ?? "";

  if (isRetry) {
    const retryInput = await prepareRetry(graph, chatId);
    if (!retryInput) {
      sendJson(res, 400, { error: "nothing to retry yet" });
      return;
    }
    input = retryInput;
  } else if (!input.trim()) {
    sendJson(res, 400, { error: "message text is required" });
    return;
  } else {
    chats.maybeAutoTitle(chatId, input);
  }
  chats.touch(chatId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  activeAborts.get(chatId)?.abort();
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  req.on("close", () => {
    if (activeAborts.get(chatId) === abortController) abortController.abort();
  });

  const turnStarted = Date.now();

  try {
    const stream = await graph.stream(
      { messages: isRetry ? [] : [new HumanMessage(input)] },
      {
        configurable: { thread_id: chatId, thinking: thinkingMode },
        signal: abortController.signal,
        streamMode: "messages",
      },
    );

    let generatedChars = 0;
    const pendingToolCalls = new Map<string | number, { name: string; args: string }>();

    for await (const [chunk] of stream) {
      const type = chunk.getType();

      if (type === "tool") {
        const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
        const pending = [...pendingToolCalls.values()].find((call) => call.name === toolName);
        if (pending) {
          sseWrite(res, "tool_call", { name: pending.name, summary: summarizeToolCall(pending.name, pending.args) });
          const key = [...pendingToolCalls.entries()].find(([, call]) => call === pending)?.[0];
          if (key !== undefined) pendingToolCalls.delete(key);
        }
        sseWrite(res, "tool_result", { name: toolName, content: String(chunk.content) });
        continue;
      }

      if (type !== "ai") continue;

      const toolCallChunks = (
        chunk as unknown as { tool_call_chunks?: { name?: string; args?: string; index?: number; id?: string }[] }
      ).tool_call_chunks;

      if (toolCallChunks?.length) {
        for (const tc of toolCallChunks) {
          const key = tc.index ?? tc.id ?? tc.name ?? 0;
          const pending = pendingToolCalls.get(key) ?? { name: tc.name ?? "tool", args: "" };
          pending.name = tc.name ?? pending.name;
          pending.args += tc.args ?? "";
          pendingToolCalls.set(key, pending);
          if (tc.args) generatedChars += tc.args.length;
        }
        continue;
      }

      if (typeof chunk.content !== "string" || !chunk.content) continue;
      generatedChars += chunk.content.length;
      sseWrite(res, "text", { delta: chunk.content });
    }

    const elapsedSeconds = (Date.now() - turnStarted) / 1000;
    const generatedTokens = Math.max(1, Math.round(generatedChars / 4));
    const contextTokens = await estimateContextUsage(graph, chatId);
    sseWrite(res, "done", { elapsedSeconds, generatedTokens, contextTokens, maxTokens: config.contextWindowTokens });
  } catch (err) {
    if (abortController.signal.aborted) {
      sseWrite(res, "aborted", {});
    } else {
      sseWrite(res, "error", { message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (activeAborts.get(chatId) === abortController) activeAborts.delete(chatId);
    res.end();
  }
}

async function handleStop(res: ServerResponse, chatId: string | undefined): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const wasActive = activeAborts.has(chatId);
  activeAborts.get(chatId)?.abort();
  sendJson(res, 200, { stopped: wasActive });
}

async function handleCompact(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string }>(req);
  if (!payload || !requireChat(res, payload.chatId)) return;
  const result = await compactThread(graph, payload.chatId as string);
  sendJson(res, 200, result);
}

async function handleArchive(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; title?: string }>(req);
  if (!payload || !requireChat(res, payload.chatId)) return;
  const chatId = payload.chatId as string;
  if (payload.title?.trim()) chats.rename(chatId, payload.title.trim());
  const archive = await archiveThread(graph, chatId, chats.get(chatId)?.title);
  sendJson(res, 200, archive);
}

async function handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; path?: string }>(req);
  if (!payload || !requireChat(res, payload.chatId)) return;
  if (!payload.path) {
    sendJson(res, 400, { error: "archive path is required" });
    return;
  }
  try {
    const count = await resumeThread(graph, payload.chatId as string, payload.path);
    sendJson(res, 200, { count });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleStatus(res: ServerResponse, chatId: string | undefined): Promise<void> {
  const id = chatId && chats.get(chatId) ? chatId : LEGACY_CHAT_ID;
  const contextTokens = await estimateContextUsage(graph, id);
  sendJson(res, 200, {
    model: config.nemotronModel,
    toolCount: tools.length,
    contextTokens,
    maxTokens: config.contextWindowTokens,
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const chatMatch = path.match(/^\/api\/chats\/([^/]+)(\/messages)?$/);

  if (req.method === "GET" && path === "/api/chats") {
    handleListChats(res).catch((err) => console.error("[ultron-web] list chats failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/chats") {
    handleCreateChat(req, res).catch((err) => console.error("[ultron-web] create chat failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/messages" && req.method === "GET") {
    handleChatMessages(res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] chat messages failed:", err));
    return;
  }
  if (chatMatch && !chatMatch[2] && req.method === "PATCH") {
    handleRenameChat(req, res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] rename chat failed:", err));
    return;
  }
  if (chatMatch && !chatMatch[2] && req.method === "DELETE") {
    handleDeleteChat(res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] delete chat failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/turn") {
    handleTurn(req, res).catch((err) => {
      console.error("[ultron-web] turn handler failed:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
    return;
  }
  if (req.method === "POST" && path === "/api/stop") {
    readJson<{ chatId?: string }>(req)
      .then((payload) => handleStop(res, payload?.chatId))
      .catch((err) => console.error("[ultron-web] stop handler failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/compact") {
    handleCompact(req, res).catch((err) => console.error("[ultron-web] compact handler failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/archive") {
    handleArchive(req, res).catch((err) => console.error("[ultron-web] archive handler failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/resume") {
    handleResume(req, res).catch((err) => console.error("[ultron-web] resume handler failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/status") {
    handleStatus(res, url.searchParams.get("chatId") ?? undefined).catch((err) => console.error("[ultron-web] status handler failed:", err));
    return;
  }
  if (req.method === "GET" && serveStatic(req, res)) return;

  sendJson(res, 404, { error: "not found" });
});

server.listen(config.webPort, () => {
  console.log(`[ultron-web] listening on http://localhost:${config.webPort}`);
});
