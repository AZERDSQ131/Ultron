import { appendFileSync, createReadStream, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import {
  archiveThread,
  buildGraph,
  compactThread,
  estimateContextUsage,
  getPendingApproval,
  listChatMessages,
  prepareEdit,
  prepareRetry,
  resumeThread,
  searchMessages,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { config } from "../../config.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { getChatRegistry, LEGACY_CHAT_ID, type SecurityMode } from "../../core/memory/chats.js";
import { AgentRegistry } from "../../core/memory/agents.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { tools, toolScopes } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
import { abortRun, isRunning, subscribeToRun } from "../../core/runs.js";
import { withThreadLock } from "../../core/threadLock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const debugLogPath = join(__dirname, "..", "..", "..", "ultron-web.log");
function debugLog(message: string): void {
  const line = `[${new Date().toISOString()}] [web] ${message}`;
  console.error(line);
  try { appendFileSync(debugLogPath, `${line}\n`); } catch { /* diagnostics must never break the server */ }
}

const graph = buildGraph();
const chats = getChatRegistry(config.databasePath);
const agents = new AgentRegistry(config.databasePath);
const todos = getTodoRegistry(config.databasePath);
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
  const payload = await readJson<{ title?: string; agentId?: string | null }>(req);
  if (!payload) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (payload.agentId && !agents.getAgent(payload.agentId)) { sendJson(res, 404, { error: "unknown agent" }); return; }
  const chat = chats.create(payload.title?.trim() || undefined, payload.agentId ?? null);
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
  // Tells the client whether to open GET /api/chats/:id/stream (see
  // handleAttachToRun) right after loading this history — true for a
  // spawn_agent execution chat (see tools/agents.ts) still in progress.
  sendJson(res, 200, { messages, running: isRunning(chatId) });
}

// Backs the web UI's right-side to-do panel — read straight from the todos
// table (tools/todos.ts) rather than the checkpointed message history, so it
// stays cheap to poll after every todo_write tool_result without re-walking
// the whole thread.
async function handleChatTodos(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  sendJson(res, 200, { items: todos.get(chatId) });
}

// Shared by a fresh turn (HumanMessage input) and an approval resume
// (Command input) — both just feed a different input into the same
// graph.stream()/SSE pump. Ends either on a normal "done"/"aborted"/"error"
// event, or on "approval_required" when the tools node's interrupt() call
// (see toolsNode in graph.ts) pauses the thread waiting on a human decision.
async function streamGraphTurn(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
  thinkingMode: ThinkingMode,
  input: { messages: HumanMessage[] } | Command,
): Promise<void> {
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
    // Serialized per chatId (see threadLock.ts) so this can never run
    // concurrently with, e.g., a spawn_agent wake-up note (tools/agents.ts)
    // landing on the same chat mid-stream — that race was corrupting live
    // replies with stray tool/report text from the other run.
    await withThreadLock(chatId, async () => {
      const stream = await graph.stream(input, {
        configurable: { thread_id: chatId, thinking: thinkingMode },
        signal: abortController.signal,
        streamMode: "messages",
      });

      let generatedChars = 0;
      let outputTokens: number | undefined;
      const pendingToolCalls = new Map<string | number, { name: string; args: string }>();

      for await (const [chunk] of stream) {
        const type = chunk.getType();

        if (type === "tool") {
          const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
          debugLog(`tool result chat=${chatId} name=${toolName} content=${JSON.stringify(String(chunk.content).slice(0, 500))}`);
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
          debugLog(`tool call chunks chat=${chatId} chunks=${JSON.stringify(toolCallChunks)}`);
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

        const usage = (chunk as unknown as { usage_metadata?: { output_tokens?: number } }).usage_metadata;
        if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;

        if (typeof chunk.content !== "string" || !chunk.content) continue;
        generatedChars += chunk.content.length;
        sseWrite(res, "text", { delta: chunk.content });
      }

      const pendingApproval = await getPendingApproval(graph, chatId);
      if (pendingApproval) {
        debugLog(`approval required chat=${chatId} calls=${JSON.stringify(pendingApproval.calls.map((c) => c.name))}`);
        sseWrite(res, "approval_required", { calls: pendingApproval.calls });
      } else {
        const elapsedSeconds = (Date.now() - turnStarted) / 1000;
        // Nemotron's endpoint returns real usage on the stream's final chunk
        // (see nemotron.ts); fall back to the chars/4 estimate only if a turn
        // was interrupted before that chunk arrived.
        const generatedTokens = outputTokens ?? Math.max(1, Math.round(generatedChars / 4));
        const contextTokens = await estimateContextUsage(graph, chatId);
        sseWrite(res, "done", { elapsedSeconds, generatedTokens, contextTokens, maxTokens: config.contextWindowTokens });
      }
    });
  } catch (err) {
    debugLog(`turn error chat=${chatId} error=${err instanceof Error ? err.stack ?? err.message : String(err)}`);
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
  debugLog(`turn received chat=${chatId} retry=${isRetry} text=${JSON.stringify(input)}`);

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

  await streamGraphTurn(req, res, chatId, thinkingMode, { messages: isRetry ? [] : [new HumanMessage(input)] });
}

// Resumes a thread paused on toolsNode's interrupt() (see graph.ts) with the
// user's per-call approve/deny decisions, then keeps streaming the rest of
// the turn — including a further approval_required if another destructive
// call follows immediately.
async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; thinking?: ThinkingMode; decisions?: ToolApprovalDecision }>(req);
  if (!payload || !requireChat(res, payload.chatId)) return;
  const chatId = payload.chatId as string;
  if (!payload.decisions) {
    sendJson(res, 400, { error: "decisions is required" });
    return;
  }
  const thinkingMode: ThinkingMode = payload.thinking ?? "full";
  await streamGraphTurn(req, res, chatId, thinkingMode, new Command({ resume: payload.decisions }));
}

async function handleSetSecurity(req: IncomingMessage, res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const payload = await readJson<{ mode?: SecurityMode }>(req);
  if (!payload?.mode || !["bypass", "accept_edit", "manual"].includes(payload.mode)) {
    sendJson(res, 400, { error: "mode must be bypass, accept_edit or manual" });
    return;
  }
  chats.setSecurityMode(chatId, payload.mode);
  sendJson(res, 200, { chat: chats.get(chatId) });
}

async function handleStop(res: ServerResponse, chatId: string | undefined): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const wasActive = activeAborts.has(chatId);
  activeAborts.get(chatId)?.abort();
  // Covers both kinds of run this server can have going on a chat: a
  // request-scoped turn (activeAborts, above) and a spawn_agent background
  // run registered in runs.ts — same Stop button either way.
  const wasBackgroundRun = abortRun(chatId);
  sendJson(res, 200, { stopped: wasActive || wasBackgroundRun });
}

// Lets the web UI open a chat that's currently running as a background
// spawn_agent execution (see tools/agents.ts) and see it live — tool calls,
// text, the works — instead of only the finished result once someone
// happens to refresh. If the chat isn't running, this just says so and
// closes; the client already has (or fetches) the static history for that
// case via GET /api/chats/:id/messages.
async function handleAttachToRun(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (!isRunning(chatId)) {
    sseWrite(res, "not_running", {});
    res.end();
    return;
  }

  sseWrite(res, "attached", {});
  const unsubscribe = subscribeToRun(chatId, (event) => {
    sseWrite(res, event.type, event);
    if (event.type === "done" || event.type === "aborted" || event.type === "error") res.end();
  });
  // subscribeToRun can't return undefined here (isRunning just confirmed a
  // handle exists), but the run can still finish between those two calls —
  // guard defensively rather than assume the race can't happen.
  if (!unsubscribe) {
    sseWrite(res, "not_running", {});
    res.end();
    return;
  }
  res.on("close", unsubscribe);
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

// Lightweight liveness probe — a real (cheap) DB query but no LLM call — so
// anything that needs to know the process is up and the shared SQLite file
// is reachable (a future Telegram bot, a supervisor script) doesn't have to
// hit a heavier endpoint just to check.
async function handleHealth(res: ServerResponse): Promise<void> {
  let databaseReachable = true;
  try {
    chats.list();
  } catch {
    databaseReachable = false;
  }
  sendJson(res, databaseReachable ? 200 : 503, {
    status: databaseReachable ? "ok" : "degraded",
    uptimeSeconds: Math.round(process.uptime()),
    model: config.nemotronModel,
    databaseReachable,
  });
}

async function handleEdit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string }>(req);
  if (!payload || !requireChat(res, payload.chatId)) return;
  const content = await prepareEdit(graph, payload.chatId as string);
  if (content === undefined) {
    sendJson(res, 400, { error: "nothing to edit yet" });
    return;
  }
  sendJson(res, 200, { content });
}

async function handleSearch(res: ServerResponse, query: string | undefined): Promise<void> {
  const q = (query ?? "").trim();
  if (!q) {
    sendJson(res, 200, { results: [] });
    return;
  }
  const chatById = new Map(chats.list().map((chat) => [chat.id, chat]));
  const matches = await searchMessages(graph, [...chatById.keys()], q);
  const results = [...matches.entries()].map(([chatId, chatMatches]) => ({
    chatId,
    chatTitle: chatById.get(chatId)?.title ?? "untitled",
    updatedAt: chatById.get(chatId)?.updatedAt,
    matches: chatMatches.slice(0, 3),
  }));
  sendJson(res, 200, { results });
}

async function handleTools(res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    tools: tools.map((t) => ({ name: t.name, scope: toolScopes[t.name] ?? "read", description: t.description })),
  });
}

async function handleAgents(res: ServerResponse): Promise<void> { sendJson(res, 200, { agents: agents.listAgents() }); }
async function handleCreateAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const p = await readJson<{ name?: string; description?: string; instructions?: string }>(req);
  if (!p?.name?.trim()) { sendJson(res, 400, { error: "name is required" }); return; }
  sendJson(res, 200, { agent: agents.createAgent(p.name.trim(), p.description?.trim() ?? "", p.instructions?.trim() ?? "") });
}
async function handleDeleteAgent(res: ServerResponse, id: string): Promise<void> {
  if (!agents.getAgent(id)) { sendJson(res, 404, { error: "unknown agent" }); return; }
  for (const chat of chats.list().filter((candidate) => candidate.agentId === id)) chats.delete(chat.id);
  agents.deleteAgent(id);
  sendJson(res, 200, { deleted: true });
}
async function handleSchedules(res: ServerResponse): Promise<void> { sendJson(res, 200, { schedules: agents.listSchedules() }); }
async function handleCreateSchedule(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const p = await readJson<{ agentId?: string | null; name?: string; instruction?: string; cron?: string; timezone?: string }>(req);
  if (!p?.name?.trim() || !p.instruction?.trim() || !p.cron?.trim()) { sendJson(res, 400, { error: "name, instruction and cron are required" }); return; }
  if (p.agentId && !agents.getAgent(p.agentId)) { sendJson(res, 404, { error: "unknown agent" }); return; }
  try { sendJson(res, 200, { schedule: agents.createSchedule({ ...p, name: p.name.trim(), instruction: p.instruction.trim(), cron: p.cron.trim() }) }); } catch (err) { sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
}
async function handleScheduleAction(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> { const p = await readJson<{ enabled?: boolean }>(req); agents.setScheduleEnabled(id, p?.enabled === true); sendJson(res, 200, { schedules: agents.listSchedules() }); }
async function handleDeleteSchedule(res: ServerResponse, id: string): Promise<void> { agents.deleteSchedule(id); sendJson(res, 200, { deleted: true }); }

async function runDueSchedules(): Promise<void> {
  agents.cleanupCompletedSchedules();
  for (const task of agents.getDueSchedules()) {
    debugLog(`scheduler picked id=${task.id} name=${task.name} agent=${task.agentId ?? "ultron"}`);
    agents.markRun(task.id);
    const execution = chats.create(`Scheduled: ${task.name}`, task.agentId, task.id);
    agents.setLastRunChat(task.id, execution.id);
    // Owner instructions (if any) are no longer prefixed here — a chat
    // owned by an Agent already gets them as its system prompt (see
    // buildAgentSystemPrompt in graph.ts), which also keeps this execution
    // out of ULTRON's own SOUL.md persona and memory.
    const prompt = `This is a scheduled task. Execute it now and report exactly what happened.\n\nTask: ${task.instruction}`;
    try { await withThreadLock(execution.id, () => graph.invoke({ messages: [new HumanMessage(prompt)] }, { configurable: { thread_id: execution.id, thinking: "low" } })); }
    catch (err) { debugLog(`scheduled task failed name=${task.name} error=${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
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
  const chatMatch = path.match(/^\/api\/chats\/([^/]+)(\/messages|\/todos)?$/);

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
  if (chatMatch && chatMatch[2] === "/todos" && req.method === "GET") {
    handleChatTodos(res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] chat todos failed:", err));
    return;
  }
  const streamMatch = path.match(/^\/api\/chats\/([^/]+)\/stream$/);
  if (streamMatch && req.method === "GET") {
    handleAttachToRun(res, decodeURIComponent(streamMatch[1])).catch((err) => console.error("[ultron-web] attach to run failed:", err));
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
  const securityMatch = path.match(/^\/api\/chats\/([^/]+)\/security$/);
  if (securityMatch && req.method === "PATCH") {
    handleSetSecurity(req, res, decodeURIComponent(securityMatch[1])).catch((err) => console.error("[ultron-web] set security failed:", err));
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
  if (req.method === "POST" && path === "/api/approve") {
    handleApprove(req, res).catch((err) => {
      console.error("[ultron-web] approve handler failed:", err);
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
  if (req.method === "POST" && path === "/api/edit") {
    handleEdit(req, res).catch((err) => console.error("[ultron-web] edit handler failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/search") {
    handleSearch(res, url.searchParams.get("q") ?? undefined).catch((err) => console.error("[ultron-web] search handler failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/tools") {
    handleTools(res).catch((err) => console.error("[ultron-web] tools handler failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/agents") { handleAgents(res).catch((err) => console.error("[ultron-web] list agents failed:", err)); return; }
  if (req.method === "POST" && path === "/api/agents") { handleCreateAgent(req, res).catch((err) => console.error("[ultron-web] create agent failed:", err)); return; }
  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && req.method === "DELETE") { handleDeleteAgent(res, decodeURIComponent(agentMatch[1])).catch((err) => console.error("[ultron-web] delete agent failed:", err)); return; }
  if (req.method === "GET" && path === "/api/schedules") { handleSchedules(res).catch((err) => console.error("[ultron-web] list schedules failed:", err)); return; }
  if (req.method === "POST" && path === "/api/schedules") { handleCreateSchedule(req, res).catch((err) => console.error("[ultron-web] create schedule failed:", err)); return; }
  const scheduleMatch = path.match(/^\/api\/schedules\/([^/]+)$/);
  if (scheduleMatch && req.method === "PATCH") { handleScheduleAction(req, res, decodeURIComponent(scheduleMatch[1])).catch((err) => console.error("[ultron-web] schedule action failed:", err)); return; }
  if (scheduleMatch && req.method === "DELETE") { handleDeleteSchedule(res, decodeURIComponent(scheduleMatch[1])).catch((err) => console.error("[ultron-web] delete schedule failed:", err)); return; }
  if (req.method === "GET" && path === "/api/health") {
    handleHealth(res).catch((err) => console.error("[ultron-web] health handler failed:", err));
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
setInterval(() => { runDueSchedules().catch((err) => console.error("[ultron-web] scheduler failed:", err)); }, 15_000).unref();
