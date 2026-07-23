import { createReadStream, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import {
  buildGraph,
  compactThread,
  estimateContextUsage,
  getPendingApproval,
  listChatMessages,
  prepareEdit,
  prepareRetry,
  searchMessages,
  type TaskMode,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { config, setActiveModel, setActiveProvider, hasProviderCredentials, PROVIDER_CYCLE } from "../../config.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { listAvailableModels, listModelsByProvider, resolveModelContext, type ModelInfo } from "../../core/llm/models.js";
import { formatTurnStats, recordUsage } from "../../core/llm/usage.js";
import { recordUserModelObservation } from "../../core/userModelExtractor.js";
import { autoTitleChat } from "../../core/chatTitler.js";
import { getUserModelRegistry } from "../../core/memory/userModel.js";
import { CLI_CHAT_SCOPE, getChatRegistry, LEGACY_CHAT_ID, type ChatOrigin, type SecurityMode } from "../../core/memory/chats.js";
import { defaultExportPath, maybeExportChat, resolveExportPath } from "../../core/memory/exporter.js";
import { AgentRegistry } from "../../core/memory/agents.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { getGoalRegistry } from "../../core/memory/goals.js";
import { getHealthRegistry, pickLatestWithData, type HealthExportPayload, type HealthMetric } from "../../core/memory/health.js";
import { computeActivityScore, computeRecoveryScore } from "../../core/health/scoring.js";
import { detectAnomalies } from "../../core/health/trends.js";
import { estimateBiologicalAge } from "../../core/health/bioAge.js";
import { getMealExerciseLogRegistry } from "../../core/memory/mealExerciseLog.js";
import { resolvePhotoPath } from "../../core/health/photoStorage.js";
import { getChatEventRegistry, type ChatEventSource } from "../../core/memory/chatEvents.js";
import { buildContinuationPrompt, gatherCodeContext, gatherHealthContext, judgeGoal } from "../../core/goalJudge.js";
import { listSkills, readSkill } from "../../core/skills.js";
import { installHubSkill, listHubSkills } from "../../core/skillsHub.js";
import { tools, toolScopes } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
import { abortRun, isRunning, subscribeToRun } from "../../core/runs.js";
import { withThreadLock } from "../../core/threadLock.js";
import { log } from "../../core/logger.js";
import { saveUpload } from "../../core/uploads.js";
import { getUsageRegistry } from "../../core/memory/usage.js";
import { getFinanceRegistry, type AccountType } from "../../core/memory/finance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
function debugLog(message: string): void {
  log("web", message);
}

let graph = buildGraph();
const fallbackContextWindowTokens = config.contextWindowTokens;
const chats = getChatRegistry(config.databasePath);
const agents = new AgentRegistry(config.databasePath);
const todos = getTodoRegistry(config.databasePath);
const goals = getGoalRegistry(config.databasePath);
const chatEvents = getChatEventRegistry(config.databasePath);
// Migrates the CLI's original hardcoded thread ("ultron-main", used before
// chats existed) into the registry on first run, so pre-existing history
// shows up as a chat instead of being orphaned. Runs at most once ever
// (see ensureLegacyMigration): if the user later deletes that chat, this
// must not resurrect it on the next restart/deploy.
chats.ensureLegacyMigration();

// One AbortController per chat, so stopping or starting a generation in one
// chat can't affect another that happens to also be streaming (e.g. the CLI
// generating on a different chat at the same time).
const activeAborts = new Map<string, AbortController>();

function expandSkillMentions(message: string): string {
  const names = new Set(listSkills().map((skill) => skill.name));
  const mentioned = [...message.matchAll(/(?:^|\s)@([\w-]+)/g)]
    .map((match) => match[1])
    .filter((name, index, all) => names.has(name) && all.indexOf(name) === index);
  if (!mentioned.length) return message;
  const blocks = mentioned.map((name) => `<skill name="${name}">\n${readSkill(name) ?? ""}\n</skill>`);
  return `${message}\n\n---\n${blocks.join("\n\n")}`;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
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

function originLabel(raw: "CLI" | "Tel" | "App"): ChatOrigin {
  if (raw === "Tel") return "telegram";
  if (raw === "App") return "app";
  return "cli";
}

async function handleListChats(res: ServerResponse): Promise<void> {
  // origin: "cli" | "telegram" | "app" — lets a client (the mobile app) show
  // which interface a conversation came from without duplicating getOrigin's
  // logic.
  const withOrigin = chats.list().map((chat) => ({
    ...chat,
    origin: originLabel(chats.getOrigin(chat.id)),
  }));
  sendJson(res, 200, { chats: withOrigin });
}

async function handleCreateChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ title?: string; agentId?: string | null; origin?: ChatOrigin }>(req);
  if (!payload) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (payload.agentId && !agents.getAgent(payload.agentId)) { sendJson(res, 404, { error: "unknown agent" }); return; }
  // origin defaults to "cli" — every existing caller (the web UI's own "new
  // chat" button, the remote CLI) predates this field and didn't send it;
  // only the mobile app now explicitly sends "app" so its own new chats
  // aren't mislabeled "CLI" before their first message.
  const origin: ChatOrigin = payload.origin === "app" || payload.origin === "telegram" ? payload.origin : "cli";
  const chat = chats.create(payload.title?.trim() || undefined, payload.agentId ?? null, null, origin);
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

// Explicit user-driven reset — see TodoRegistry.clear's comment for why
// this exists: the list otherwise persists across turns indefinitely,
// including into an unrelated new request, since nothing tells the system
// on its own that the previous task is done.
async function handleClearTodos(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  todos.clear(chatId);
  sendJson(res, 200, { items: [] });
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
  taskMode: TaskMode,
  input: { messages: HumanMessage[] } | Command,
  source: ChatEventSource = "cli",
  nested = false,
): Promise<void> {
  if (!nested) res.writeHead(200, {
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
  let finalText = "";

  try {
    // Serialized per chatId (see threadLock.ts) so this can never run
    // concurrently with, e.g., a spawn_agent wake-up note (tools/agents.ts)
    // landing on the same chat mid-stream — that race was corrupting live
    // replies with stray tool/report text from the other run.
    await withThreadLock(chatId, async () => {
      const stream = await graph.stream(input, {
        configurable: { thread_id: chatId, thinking: thinkingMode, taskMode },
        signal: abortController.signal,
        streamMode: "messages",
        recursionLimit: config.graphRecursionLimit,
      });

      let generatedChars = 0;
      let outputTokens: number | undefined;
      let inputTokens: number | undefined;
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

        const usage = (chunk as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
          .usage_metadata;
        if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
        if (usage?.input_tokens !== undefined) inputTokens = usage.input_tokens;

        if (typeof chunk.content !== "string" || !chunk.content) continue;
        generatedChars += chunk.content.length;
        finalText += chunk.content;
        sseWrite(res, "text", { delta: chunk.content });
      }

      const pendingApproval = await getPendingApproval(graph, chatId);
      if (pendingApproval) {
        debugLog(`approval required chat=${chatId} calls=${JSON.stringify(pendingApproval.calls.map((c) => c.name))}`);
        sseWrite(res, "approval_required", { calls: pendingApproval.calls });
      } else {
        // Close the whole plan in the host after the real work is done;
        // never spend one model turn per item changing statuses.
        todos.completeAll(chatId);
        const elapsedSeconds = (Date.now() - turnStarted) / 1000;
        // Nemotron's endpoint returns real usage on the stream's final chunk
        // (see nemotron.ts); fall back to the chars/4 estimate only if a turn
        // was interrupted before that chunk arrived.
        const generatedTokens = outputTokens ?? Math.max(1, Math.round(generatedChars / 4));
        recordUsage("chat", chatId, config.nemotronModel, inputTokens ?? 0, generatedTokens, Math.round(elapsedSeconds * 1000));
        const contextTokens = await estimateContextUsage(graph, chatId);
        const stats = formatTurnStats({
          model: config.nemotronModel,
          inputTokens: inputTokens ?? 0,
          outputTokens: generatedTokens,
          elapsedSeconds,
        });
        sseWrite(res, "done", {
          elapsedSeconds,
          generatedTokens,
          inputTokens: inputTokens ?? 0,
          stats,
          contextTokens,
          maxTokens: config.contextWindowTokens,
        });

        // Passive memory extraction (see userModelExtractor.ts) — never
        // awaited, never blocks the SSE response; only for an actual new
        // user message, not an approval-decision Command resume.
        if ("messages" in input) {
          const humanText = input.messages
            .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
            .join("\n")
            .trim();
          if (humanText && finalText.trim()) void recordUserModelObservation(chatId, humanText, finalText);
        }

        if (finalText.trim()) chatEvents.append(chatId, "ai", source, finalText.trim());

        if (taskMode === "goal") {
          const goal = goals.get(chatId);
          if (goal?.status === "active") {
            if (goal.turnsUsed >= goal.maxTurns) {
              goals.pause(chatId, `turn budget (${goal.maxTurns}) exhausted`);
              sseWrite(res, "goal", { status: "paused", reason: `turn budget (${goal.maxTurns}) exhausted` });
            } else {
              try {
                const verdict = await judgeGoal({ objective: goal.objective, finalMessage: finalText, codeContext: gatherCodeContext(), healthContext: gatherHealthContext() }, abortController.signal);
                if (verdict.verdict === "done") {
                  goals.markDone(chatId, verdict.reason);
                  sseWrite(res, "goal", { status: "complete", reason: verdict.reason });
                } else if (verdict.verdict === "blocked") {
                  goals.pause(chatId, verdict.reason);
                  sseWrite(res, "goal", { status: "paused", reason: verdict.reason });
                } else {
                  goals.recordTurn(chatId);
                  sseWrite(res, "goal", { status: "continuing", reason: verdict.reason });
                  await streamGraphTurn(req, res, chatId, thinkingMode, taskMode, {
                    messages: [new HumanMessage(buildContinuationPrompt(goal.objective, verdict.reason))],
                  }, source, true);
                }
              } catch (error) {
                goals.pause(chatId, "goal check failed");
                sseWrite(res, "goal", { status: "paused", reason: error instanceof Error ? error.message : String(error) });
              }
            }
          }
        }
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
    if (!nested) res.end();
  }
}

async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; text?: string; thinking?: ThinkingMode; taskMode?: TaskMode; retry?: boolean; source?: ChatEventSource }>(req);
  if (!payload) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (!requireChat(res, payload.chatId)) return;
  const chatId = payload.chatId as string;
  const thinkingMode: ThinkingMode = payload.thinking ?? "full";
  const taskMode: TaskMode = payload.taskMode ?? "none";
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
    chatEvents.append(chatId, "human", payload.source === "telegram" ? "telegram" : "cli", input);
    autoTitleChat(chats, chatId, input);
    if (taskMode === "goal") goals.set(chatId, input, config.goalMaxTurns);
    else goals.clear(chatId);
  }
  chats.touch(chatId);

  // Task mode applies to this request only. Clear the chat-scoped list at
  // the user-turn boundary so an interrupted or completed request cannot
  // make a new request resume an unrelated old plan. Approval resumes and
  // retries intentionally keep their existing list.
  if (!isRetry && (taskMode === "todo" || taskMode === "plan")) todos.clear(chatId);

  await streamGraphTurn(req, res, chatId, thinkingMode, taskMode, { messages: isRetry ? [] : [new HumanMessage(expandSkillMentions(input))] }, payload.source === "telegram" ? "telegram" : "cli");
  const exportedChat = chats.get(chatId);
  if (exportedChat) void maybeExportChat(graph, exportedChat);
}

// Resumes a thread paused on toolsNode's interrupt() (see graph.ts) with the
// user's per-call approve/deny decisions, then keeps streaming the rest of
// the turn — including a further approval_required if another destructive
// call follows immediately.
async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; thinking?: ThinkingMode; taskMode?: TaskMode; decisions?: ToolApprovalDecision }>(req);
  if (!payload || !requireChat(res, payload.chatId)) return;
  const chatId = payload.chatId as string;
  if (!payload.decisions) {
    sendJson(res, 400, { error: "decisions is required" });
    return;
  }
  const thinkingMode: ThinkingMode = payload.thinking ?? "full";
  const taskMode: TaskMode = payload.taskMode ?? "none";
  await streamGraphTurn(req, res, chatId, thinkingMode, taskMode, new Command({ resume: payload.decisions }));
  const exportedChat = chats.get(chatId);
  if (exportedChat) void maybeExportChat(graph, exportedChat);
}

async function handleGetExport(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const chat = chats.get(chatId);
  sendJson(res, 200, { path: chat?.exportPath ?? null });
}

async function handleSetExport(req: IncomingMessage, res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const chat = chats.get(chatId);
  if (!chat) {
    sendJson(res, 404, { error: "chat not found" });
    return;
  }
  const payload = await readJson<{ path?: string }>(req);
  const path = payload?.path?.trim() ? resolveExportPath(payload.path.trim()) : defaultExportPath(chat);
  chats.setExportPath(chatId, path);
  await maybeExportChat(graph, { ...chat, exportPath: path });
  sendJson(res, 200, { path });
}

async function handleStopExport(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  chats.setExportPath(chatId, null);
  sendJson(res, 200, { path: null });
}

// Files attached via the composer's "+" button (public/js/composer.js) —
// base64 over the existing readJson plumbing rather than a multipart
// parser, since the project has no such dependency and personal-scale file
// sizes make the ~33% base64 overhead irrelevant. Returns an absolute path
// the model can hand to its own read_file tool; no content is inlined
// here or sent to the model directly.
async function handleUpload(req: IncomingMessage, res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const payload = await readJson<{ filename?: string; dataBase64?: string }>(req);
  const filename = payload?.filename?.trim();
  if (!filename || !payload?.dataBase64) {
    sendJson(res, 400, { error: "filename and dataBase64 are required" });
    return;
  }
  const buffer = Buffer.from(payload.dataBase64, "base64");
  const saved = saveUpload(chatId, filename, buffer);
  sendJson(res, 200, saved);
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

async function handleListArchivedChats(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { chats: chats.listResumable(CLI_CHAT_SCOPE) });
}

async function handleChatEvents(res: ServerResponse, chatId: string, after: number): Promise<void> {
  if (!requireChat(res, chatId)) return;
  sendJson(res, 200, { events: chatEvents.listAfter(chatId, after), latestId: chatEvents.latestId(chatId) });
}

// Archiving is a metadata flag (see ChatRegistry.archive), not a data
// export: the chat's LangGraph checkpoint state is untouched, so resuming
// it later gets full context back, not a lossy text reconstruction.
async function handleArchiveChat(req: IncomingMessage, res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const payload = await readJson<{ title?: string }>(req);
  const { archived, fresh } = chats.archiveAndCreate(chatId, payload?.title);
  sendJson(res, 200, { archived, fresh });
}

async function handleResumeChat(res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const resumed = chats.unarchive(chatId);
  chats.setFocus(chatId, CLI_CHAT_SCOPE);
  sendJson(res, 200, { chat: resumed });
}

async function handleMainChat(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { chat: chats.activateMain(CLI_CHAT_SCOPE) });
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

// Ingestion for daily health-export payloads (see src/core/memory/health.ts).
// The only route on this server that requires auth: meant to be called
// directly by an external health-export app/shortcut rather than the
// browser UI, so unlike every other route here it can't rely on only being
// reachable from the local machine's own frontend.
async function handleHealthIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.healthIngestToken) {
    sendJson(res, 503, { error: "health ingest disabled: HEALTH_INGEST_TOKEN not set" });
    return;
  }
  if (req.headers["x-health-token"] !== config.healthIngestToken) {
    sendJson(res, 401, { error: "invalid or missing x-health-token" });
    return;
  }
  const payload = await readJson<HealthExportPayload>(req);
  if (!payload) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const { dates } = getHealthRegistry(config.databasePath).ingest(payload);
  sendJson(res, 200, { status: "ok", dates });
}

// Read-only data for the "Tokens" view (public/js/usageView.js) — every
// LLM call ULTRON has made, across every interface and provider, logged by
// recordUsage (src/core/llm/usage.ts) at the point each call's real usage
// is already known. `days` query param (default 30, 0 = all-time) mirrors
// the health dashboard's own range picker.
async function handleUsageSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const daysParam = url.searchParams.get("days");
  const days = daysParam === null ? 30 : Number(daysParam);
  const usage = getUsageRegistry(config.databasePath);
  if (!usage.hasData()) {
    sendJson(res, 200, { hasData: false });
    return;
  }
  sendJson(res, 200, { hasData: true, ...usage.summary(days > 0 ? days : undefined) });
}

// Data for the "Finance" view (public/js/financeView.js) — manual-entry
// accounts/balances/transactions (src/core/memory/finance.ts), no bank
// sync provider wired up yet. `days` mirrors the health/usage range picker.
async function handleFinanceSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const finance = getFinanceRegistry(config.databasePath);
  if (!finance.hasData()) {
    sendJson(res, 200, { hasData: false });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const days = Number(url.searchParams.get("days") ?? 30);
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const monthTo = new Date().toISOString().slice(0, 10);
  const monthFrom = `${monthTo.slice(0, 7)}-01`;
  sendJson(res, 200, {
    hasData: true,
    netWorth: finance.netWorth(),
    accounts: finance.listAccountsWithBalance(),
    netWorthHistory: finance.getNetWorthHistory(from, to),
    transactions: finance.listTransactions(50),
    monthSummary: finance.currentMonthSummary(),
    spendingByCategory: finance.getSpendingByCategory(monthFrom, monthTo),
    monthlyCashFlow: finance.getMonthlyCashFlow(6),
  });
}

async function handleFinanceCreateAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ name?: string; type?: string; currency?: string }>(req);
  const name = payload?.name?.trim();
  const type = payload?.type;
  if (!name || !["checking", "savings", "investment", "crypto", "loan", "other"].includes(type ?? "")) {
    sendJson(res, 400, { error: "name and a valid type are required" });
    return;
  }
  const finance = getFinanceRegistry(config.databasePath);
  if (finance.findAccountByName(name)) {
    sendJson(res, 400, { error: `an account named "${name}" already exists` });
    return;
  }
  const account = finance.createAccount(name, type as AccountType, payload?.currency?.trim() || "EUR");
  sendJson(res, 200, { account });
}

async function handleFinanceDeleteAccount(res: ServerResponse, id: string): Promise<void> {
  const finance = getFinanceRegistry(config.databasePath);
  sendJson(res, 200, { deleted: finance.deleteAccount(id) });
}

async function handleFinanceRecordBalance(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const finance = getFinanceRegistry(config.databasePath);
  if (!finance.getAccount(id)) {
    sendJson(res, 404, { error: "unknown account" });
    return;
  }
  const payload = await readJson<{ balance?: number; date?: string }>(req);
  if (typeof payload?.balance !== "number") {
    sendJson(res, 400, { error: "balance (number) is required" });
    return;
  }
  const snapshot = finance.recordBalance(id, payload.balance, payload.date);
  sendJson(res, 200, { snapshot });
}

async function handleFinanceAddTransaction(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const finance = getFinanceRegistry(config.databasePath);
  if (!finance.getAccount(id)) {
    sendJson(res, 404, { error: "unknown account" });
    return;
  }
  const payload = await readJson<{ description?: string; amount?: number; date?: string; category?: string }>(req);
  if (!payload?.description?.trim() || typeof payload.amount !== "number") {
    sendJson(res, 400, { error: "description and amount (number) are required" });
    return;
  }
  const transaction = finance.addTransaction(id, payload.description.trim(), payload.amount, payload.date, payload.category?.trim() || null);
  sendJson(res, 200, { transaction });
}

// Read-only data for the health dashboard view (public/js/healthView.js,
// folded into the main app shell rather than a separate page). Computes
// per-day recovery/activity scores against the CURRENT baseline for every
// day in the window (not a historical baseline-at-the-time), same
// simplification the <health_recent> prompt block and health_query's
// 'scores' mode already make — good enough for a personal trend chart.
async function handleHealthSummary(res: ServerResponse): Promise<void> {
  const health = getHealthRegistry(config.databasePath);
  if (!health.hasData()) {
    sendJson(res, 200, { hasData: false });
    return;
  }
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rangeDays = health.getRange(from, to);
  const getBaseline30 = (m: HealthMetric) => health.getBaseline(m, 30);

  const days = rangeDays.map((day) => ({
    date: day.date,
    steps: day.steps,
    activeEnergyKcal: day.activeEnergyKcal,
    distanceKm: day.distanceKm,
    exerciseMinutes: day.exerciseMinutes,
    flightsClimbed: day.flightsClimbed,
    workoutCount: day.workoutCount,
    restingHR: day.restingHR,
    walkingHR: day.walkingHR,
    sleepDurationSec: day.sleepDurationSec,
    sleepAsleepSec: day.sleepAsleepSec,
    hrvAvg: day.hrvAvg,
    respiratoryRateAvg: day.respiratoryRateAvg,
    recovery: computeRecoveryScore(day, getBaseline30),
    activity: computeActivityScore(day, getBaseline30),
  }));

  const latest = pickLatestWithData(rangeDays)!;
  const latestRecovery = computeRecoveryScore(latest, getBaseline30);
  const latestActivity = computeActivityScore(latest, getBaseline30);
  const anomalies = detectAnomalies(latest, getBaseline30);
  const records = health.getRecords();
  const sleepDebt = health.getSleepDebt();
  const profile = health.getProfile();
  const bioAge = profile.birthdate
    ? estimateBiologicalAge((Date.now() - new Date(profile.birthdate).getTime()) / (365.25 * 24 * 60 * 60 * 1000), {
        restingHR: latest.restingHR,
        hrvAvg: latest.hrvAvg,
        sleepEfficiencyPct:
          latest.sleepAsleepSec !== null && latest.sleepDurationSec !== null && latest.sleepDurationSec > 0
            ? (latest.sleepAsleepSec / latest.sleepDurationSec) * 100
            : null,
        activityScore: latestActivity,
      })
    : undefined;

  const mealExerciseLog = getMealExerciseLogRegistry(config.databasePath);
  const meals = mealExerciseLog.getMeals(from, to).map((m) => ({
    id: m.id,
    date: m.date,
    timestamp: m.timestamp,
    description: m.description,
    estimatedCalories: m.estimatedCalories,
    proteinG: m.proteinG,
    carbsG: m.carbsG,
    fatG: m.fatG,
    photoUrl: m.photoPath ? `/api/health-data/photo/${encodeURIComponent(m.photoPath)}` : null,
  }));
  const exercises = mealExerciseLog.getExercises(from, to).map((e) => ({
    id: e.id,
    date: e.date,
    timestamp: e.timestamp,
    description: e.description,
    exerciseType: e.exerciseType,
    durationMinutes: e.durationMinutes,
    intensity: e.intensity,
    estimatedCaloriesBurned: e.estimatedCaloriesBurned,
    photoUrl: e.photoPath ? `/api/health-data/photo/${encodeURIComponent(e.photoPath)}` : null,
  }));

  const latestScores = { date: latest.date, recovery: latestRecovery, activity: latestActivity };
  sendJson(res, 200, { hasData: true, from, to, days, records, sleepDebt, anomalies, bioAge, latestScores, latestRawJson: latest.rawJson, meals, exercises });
}

// Serves meal/exercise photos from disk (see photoStorage.ts) — not under
// PUBLIC_DIR/serveStatic since these live outside the app's static assets,
// next to the SQLite file. Same normalize+startsWith traversal guard as
// serveStatic. Unauthenticated like the rest of the browser-facing routes
// (only /api/health-data/ingest requires a token — see handleHealthIngest);
// this server is only meant to be reachable over the user's own Tailscale
// network, not the public internet.
function serveHealthPhoto(req: IncomingMessage, res: ServerResponse): boolean {
  const prefix = "/api/health-data/photo/";
  const url = req.url ?? "";
  if (!url.startsWith(prefix)) return false;
  const relativePath = decodeURIComponent(url.slice(prefix.length).split("?")[0]);
  const safePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolvePhotoPath(safePath);
  if (!filePath.startsWith(resolvePhotoPath("")) || !existsSync(filePath)) return false;
  const type = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(filePath).pipe(res);
  return true;
}

// Web-UI parity for the CLI/Telegram /memory command (passive user-model
// observations, see src/core/memory/userModel.ts) — previously only
// reachable from the CLI, so "every command" in the redesigned web UI had a
// real gap here.
async function handleMemoryList(res: ServerResponse): Promise<void> {
  const registry = getUserModelRegistry(config.databasePath);
  sendJson(res, 200, { observations: registry.list(200), count: registry.count() });
}
async function handleMemoryClear(res: ServerResponse): Promise<void> {
  getUserModelRegistry(config.databasePath).clear();
  sendJson(res, 200, { status: "ok" });
}
async function handleMemoryForget(res: ServerResponse, id: string): Promise<void> {
  const parsed = Number(id);
  if (!Number.isInteger(parsed)) { sendJson(res, 400, { error: "invalid id" }); return; }
  getUserModelRegistry(config.databasePath).remove(parsed);
  sendJson(res, 200, { status: "ok" });
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

async function handleSkills(res: ServerResponse): Promise<void> {
  const local = listSkills().map((skill) => ({ name: skill.name, description: skill.description, source: "local" }));
  const localNames = new Set(local.map((skill) => skill.name));
  const hub = (await listHubSkills()).filter((skill) => !localNames.has(skill.name)).map((skill) => ({ name: skill.name, description: skill.description, source: "hub" }));
  sendJson(res, 200, { skills: [...local, ...hub] });
}

async function handleInstallSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ name?: string }>(req);
  if (!payload?.name?.trim() || !(await installHubSkill(payload.name.trim()))) { sendJson(res, 404, { error: "skill not found" }); return; }
  sendJson(res, 200, { installed: true, name: payload.name.trim() });
}

async function handleModels(res: ServerResponse): Promise<void> {
  const models = await listAvailableModels();
  sendJson(res, 200, { current: config.nemotronModel, models: models.sort((a, b) => a.id.localeCompare(b.id)) });
}

// Grouped by provider (NVIDIA / DeepSeek / Groq), regardless of which one
// is currently active — what the model picker (CLI, web, remote CLI) shows
// so picking a model from a different provider than the active one can
// switch both in one step.
async function handleModelsGrouped(res: ServerResponse): Promise<void> {
  const groups = await listModelsByProvider();
  sendJson(res, 200, { current: config.nemotronModel, currentProvider: config.provider, groups });
}

async function handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ model?: string }>(req);
  const model = payload?.model?.trim();
  if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
  const selected = await resolveModelContext<ModelInfo>({ id: model });
  setActiveModel(model);
  config.contextWindowTokens = selected.contextWindowTokens ?? fallbackContextWindowTokens;
  graph = buildGraph();
  sendJson(res, 200, { model });
}

async function handleProvider(res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    current: config.provider,
    providers: PROVIDER_CYCLE,
    configured: PROVIDER_CYCLE.filter((p) => hasProviderCredentials(p)),
  });
}

async function handleSetProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ provider?: string }>(req);
  const provider = payload?.provider;
  if (provider !== "nvidia" && provider !== "deepseek" && provider !== "groq") { sendJson(res, 400, { error: "provider must be nvidia, deepseek or groq" }); return; }
  if (!hasProviderCredentials(provider)) { sendJson(res, 400, { error: `${provider.toUpperCase()}_API_KEY is not set` }); return; }
  setActiveProvider(provider);
  const models = await listAvailableModels();
  const currentModel = models.find((m) => m.id === config.nemotronModel);
  config.contextWindowTokens = (currentModel ? await resolveModelContext(currentModel) : undefined)?.contextWindowTokens ?? fallbackContextWindowTokens;
  graph = buildGraph();
  sendJson(res, 200, { provider: config.provider, model: config.nemotronModel });
}

async function handleAgents(res: ServerResponse): Promise<void> { sendJson(res, 200, { agents: agents.listAgents() }); }
async function handleCreateAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const p = await readJson<{ name?: string; description?: string; instructions?: string }>(req);
  if (!p?.name?.trim()) { sendJson(res, 400, { error: "name is required" }); return; }
  sendJson(res, 200, { agent: agents.createAgent(p.name.trim(), p.description?.trim() ?? "", p.instructions?.trim() ?? "") });
}
// Shared by the explicit DELETE /api/agents/:id route and the periodic
// ephemeral-agent sweep below — an Agent's chats are never left orphaned
// pointing at a deleted owner, whichever path triggered the deletion.
function purgeAgent(id: string): void {
  for (const chat of chats.listAll().filter((candidate) => candidate.agentId === id)) chats.delete(chat.id);
  agents.deleteAgent(id);
}

async function handleDeleteAgent(res: ServerResponse, id: string): Promise<void> {
  if (!agents.getAgent(id)) { sendJson(res, 404, { error: "unknown agent" }); return; }
  purgeAgent(id);
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
  // Ephemeral agents (spawn_agent auto-created, see tools/agents.ts) whose
  // last run ended over an hour ago — same retention window as the
  // @once-schedule cleanup above, just for agents instead of schedules.
  for (const id of agents.listExpiredEphemeralAgentIds()) purgeAgent(id);
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
    try { await withThreadLock(execution.id, () => graph.invoke({ messages: [new HumanMessage(prompt)] }, { configurable: { thread_id: execution.id, thinking: "low" }, recursionLimit: config.graphRecursionLimit })); }
    catch (err) { debugLog(`scheduled task failed name=${task.name} error=${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
  }
}

async function handleStatus(res: ServerResponse, chatId: string | undefined): Promise<void> {
  const id = chatId && chats.get(chatId) ? chatId : LEGACY_CHAT_ID;
  const contextTokens = await estimateContextUsage(graph, id);
  sendJson(res, 200, {
    model: config.nemotronModel,
    provider: config.provider,
    toolCount: tools.length,
    contextTokens,
    maxTokens: config.contextWindowTokens,
    goal: goals.get(id) ?? null,
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const chatMatch = path.match(/^\/api\/chats\/([^/]+)(\/messages|\/events|\/todos|\/archive|\/resume|\/export|\/upload)?$/);

  if (req.method === "GET" && path === "/api/chats") {
    handleListChats(res).catch((err) => console.error("[ultron-web] list chats failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/chats/archived") {
    handleListArchivedChats(res).catch((err) => console.error("[ultron-web] list archived chats failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/events" && req.method === "GET") {
    const after = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("after") ?? "0");
    handleChatEvents(res, decodeURIComponent(chatMatch[1]), Number.isFinite(after) ? after : 0).catch((err) => console.error("[ultron-web] chat events failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/chats") {
    handleCreateChat(req, res).catch((err) => console.error("[ultron-web] create chat failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/main") {
    handleMainChat(res).catch((err) => console.error("[ultron-web] activate main chat failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/archive" && req.method === "POST") {
    handleArchiveChat(req, res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] archive chat failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/resume" && req.method === "POST") {
    handleResumeChat(res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] resume chat failed:", err));
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
  if (chatMatch && chatMatch[2] === "/todos" && req.method === "DELETE") {
    handleClearTodos(res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] clear todos failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/export" && req.method === "GET") {
    handleGetExport(res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] get export failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/export" && req.method === "POST") {
    handleSetExport(req, res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] set export failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/export" && req.method === "DELETE") {
    handleStopExport(res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] stop export failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/upload" && req.method === "POST") {
    handleUpload(req, res, decodeURIComponent(chatMatch[1])).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
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
  if (req.method === "GET" && path === "/api/skills") {
    handleSkills(res).catch((err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "POST" && path === "/api/skills/install") {
    handleInstallSkill(req, res).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "GET" && path === "/api/models") {
    handleModels(res).catch((err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "GET" && path === "/api/models/grouped") {
    handleModelsGrouped(res).catch((err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "PATCH" && path === "/api/model") {
    handleSetModel(req, res).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "GET" && path === "/api/provider") {
    handleProvider(res).catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "PATCH" && path === "/api/provider") {
    handleSetProvider(req, res).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
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
  if (req.method === "POST" && path === "/api/health-data/ingest") {
    handleHealthIngest(req, res).catch((err) => console.error("[ultron-web] health ingest failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/health-data/summary") {
    handleHealthSummary(res).catch((err) => console.error("[ultron-web] health summary failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/usage/summary") {
    handleUsageSummary(req, res).catch((err) => console.error("[ultron-web] usage summary failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/finance/summary") {
    handleFinanceSummary(req, res).catch((err) => console.error("[ultron-web] finance summary failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/finance/accounts") {
    handleFinanceCreateAccount(req, res).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  const financeAccountMatch = path.match(/^\/api\/finance\/accounts\/([^/]+)(\/balance|\/transactions)?$/);
  if (financeAccountMatch && !financeAccountMatch[2] && req.method === "DELETE") {
    handleFinanceDeleteAccount(res, decodeURIComponent(financeAccountMatch[1])).catch((err) => console.error("[ultron-web] finance delete account failed:", err));
    return;
  }
  if (financeAccountMatch && financeAccountMatch[2] === "/balance" && req.method === "POST") {
    handleFinanceRecordBalance(req, res, decodeURIComponent(financeAccountMatch[1])).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (financeAccountMatch && financeAccountMatch[2] === "/transactions" && req.method === "POST") {
    handleFinanceAddTransaction(req, res, decodeURIComponent(financeAccountMatch[1])).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "GET" && path === "/api/memory") {
    handleMemoryList(res).catch((err) => console.error("[ultron-web] memory list failed:", err));
    return;
  }
  if (req.method === "DELETE" && path === "/api/memory") {
    handleMemoryClear(res).catch((err) => console.error("[ultron-web] memory clear failed:", err));
    return;
  }
  const memoryMatch = path.match(/^\/api\/memory\/([^/]+)$/);
  if (memoryMatch && req.method === "DELETE") {
    handleMemoryForget(res, decodeURIComponent(memoryMatch[1])).catch((err) => console.error("[ultron-web] memory forget failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/status") {
    handleStatus(res, url.searchParams.get("chatId") ?? undefined).catch((err) => console.error("[ultron-web] status handler failed:", err));
    return;
  }
  if (req.method === "GET" && serveHealthPhoto(req, res)) return;
  if (req.method === "GET" && serveStatic(req, res)) return;

  sendJson(res, 404, { error: "not found" });
});

server.listen(config.webPort, () => {
  console.log(`[ultron-web] listening on http://localhost:${config.webPort}`);
});
setInterval(() => { runDueSchedules().catch((err) => console.error("[ultron-web] scheduler failed:", err)); }, 15_000).unref();
