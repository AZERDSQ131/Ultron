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
  messageContentToText,
  prepareEdit,
  prepareRetry,
  searchMessages,
  type TaskMode,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { config, setActiveModel, setActiveProvider, hasProviderCredentials, PROVIDER_CYCLE } from "../../config.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { listAvailableModels, listModelsByProvider, resolveModelContext, type ModelInfo } from "../../core/llm/models.js";
import { getReasoningProfile } from "../../core/llm/reasoning.js";
import { formatTurnStats, recordUsage } from "../../core/llm/usage.js";
import { recordUserModelObservation } from "../../core/userModelExtractor.js";
import { autoTitleChat } from "../../core/chatTitler.js";
import { getUserModelRegistry } from "../../core/memory/userModel.js";
import { CLI_CHAT_SCOPE, getChatRegistry, LEGACY_CHAT_ID, type ChatOrigin, type SecurityMode } from "../../core/memory/chats.js";
import { getProjectRegistry } from "../../core/memory/projects.js";
import { defaultExportPath, maybeExportChat, resolveExportPath } from "../../core/memory/exporter.js";
import { ScheduleRegistry } from "../../core/memory/schedules.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { getResearchRegistry } from "../../core/memory/research.js";
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
import { withThreadLock } from "../../core/threadLock.js";
import { log } from "../../core/logger.js";
import { saveUpload } from "../../core/uploads.js";
import { transcribeAudio } from "../../core/transcription.js";
import { getUsageRegistry } from "../../core/memory/usage.js";
import { getFinanceRegistry, type AccountType } from "../../core/memory/finance.js";
import { getLiveActivityRegistry } from "../../core/memory/liveActivities.js";
import { getOpenAIAuthRegistry } from "../../core/memory/openaiAuth.js";
import { requestDeviceCode, pollAndExchange, decodeAccountEmail, decodeAccountId, revoke as revokeOpenAI, type DeviceCodeSession } from "../../core/llm/openaiAuth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
function debugLog(message: string): void {
  log("web", message);
}

let graph = buildGraph();
const fallbackContextWindowTokens = config.contextWindowTokens;
const chats = getChatRegistry(config.databasePath);
const projects = getProjectRegistry(config.databasePath);
const schedules = new ScheduleRegistry(config.databasePath);
const todos = getTodoRegistry(config.databasePath);
const research = getResearchRegistry(config.databasePath);
const goals = getGoalRegistry(config.databasePath);
const chatEvents = getChatEventRegistry(config.databasePath);
const openaiAuth = getOpenAIAuthRegistry(config.databasePath);
const liveActivities = getLiveActivityRegistry(config.databasePath, {
  keyId: config.apnsKeyId,
  teamId: config.apnsTeamId,
  privateKeyPath: config.apnsPrivateKeyPath,
  privateKey: config.apnsPrivateKey,
  environment: config.apnsEnvironment as "sandbox" | "production",
  bundleId: config.apnsBundleId,
});
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
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Live Activity tracking is only meaningful for turns the mobile app started —
// it is the only client that owns one. See LiveActivityRegistry for why the
// state is kept even when APNs is unavailable.
function tracksLiveActivity(source: ChatEventSource): boolean {
  return source === "app";
}

function requireChat(res: ServerResponse, chatId: unknown): chatId is string {
  if (typeof chatId !== "string" || !chatId || !chats.get(chatId)) {
    sendJson(res, 404, { error: "unknown chat" });
    return false;
  }
  return true;
}

function originLabel(raw: "CLI" | "App"): ChatOrigin {
  if (raw === "App") return "app";
  return "cli";
}

async function handleListChats(res: ServerResponse): Promise<void> {
  // origin: "cli" | "app" — lets a client (the mobile app) show
  // which interface a conversation came from without duplicating getOrigin's
  // logic.
  const chatProjects = projects.allChatProjects();
  const withOrigin = chats.list().map((chat) => ({
    ...chat,
    origin: originLabel(chats.getOrigin(chat.id)),
    projectId: chatProjects.get(chat.id) ?? null,
  }));
  sendJson(res, 200, { chats: withOrigin });
}

async function handleListProjects(res: ServerResponse): Promise<void> {
  sendJson(res, 200, { projects: projects.list() });
}

async function handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ name?: string; icon?: string; color?: string }>(req);
  if (!payload?.name?.trim()) {
    sendJson(res, 400, { error: "name is required" });
    return;
  }
  const project = projects.create(payload.name.trim(), payload.icon?.trim() || "📁", payload.color?.trim() || "#6E6E73");
  sendJson(res, 200, { project });
}

async function handleUpdateProject(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!projects.get(id)) {
    sendJson(res, 404, { error: "unknown project" });
    return;
  }
  const payload = await readJson<{ name?: string; icon?: string; color?: string }>(req);
  const project = projects.update(id, payload ?? {});
  sendJson(res, 200, { project });
}

async function handleDeleteProject(res: ServerResponse, id: string): Promise<void> {
  projects.delete(id);
  sendJson(res, 200, { deleted: true });
}

async function handleSetChatProject(req: IncomingMessage, res: ServerResponse, chatId: string): Promise<void> {
  if (!requireChat(res, chatId)) return;
  const payload = await readJson<{ projectId?: string | null }>(req);
  const projectId = payload?.projectId ?? null;
  if (projectId && !projects.get(projectId)) {
    sendJson(res, 404, { error: "unknown project" });
    return;
  }
  projects.setChatProject(chatId, projectId);
  sendJson(res, 200, { chat: { ...chats.get(chatId), projectId } });
}

async function handleCreateChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ title?: string; origin?: ChatOrigin }>(req);
  if (!payload) {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  // origin defaults to "cli" — every existing caller (the web UI's own "new
  // chat" button, the remote CLI) predates this field and didn't send it;
  // only the mobile app now explicitly sends "app" so its own new chats
  // aren't mislabeled "CLI" before their first message.
  const origin: ChatOrigin = payload.origin === "app" ? "app" : "cli";
  const chat = chats.create(payload.title?.trim() || undefined, null, origin);
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
  sendJson(res, 200, { messages, running: false });
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
    // Mobile Live Activities need the server-side turn to keep running while
    // iOS suspends the SSE client. The explicit /api/stop route still aborts
    // it when the user asks to stop.
    if (source !== "app" && activeAborts.get(chatId) === abortController) abortController.abort();
  });

  const turnStarted = Date.now();
  let finalText = "";
  // The Live Activity rewrites its streaming line in place, so it tracks the
  // current paragraph rather than the whole reply: a tool call in the middle of
  // a turn starts a new line instead of extending the previous one.
  let streamingParagraph = "";
  if (tracksLiveActivity(source) && !nested) liveActivities.begin(chatId);

  try {
    // Serialized per chatId (see threadLock.ts) so another graph execution
    // cannot land on the same chat mid-stream and corrupt the live reply.
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
          const toolContent = messageContentToText(chunk.content) || String(chunk.content);
          debugLog(`tool result chat=${chatId} name=${toolName} content=${JSON.stringify(toolContent.slice(0, 500))}`);
          const pending = [...pendingToolCalls.values()].find((call) => call.name === toolName);
          if (pending) {
            sseWrite(res, "tool_call", { name: pending.name, summary: summarizeToolCall(pending.name, pending.args) });
            if (tracksLiveActivity(source)) {
              streamingParagraph = "";
              // summarizeToolCall falls back to the bare tool name when a call
              // has no arguments worth showing; don't print it twice.
              const summary = summarizeToolCall(pending.name, pending.args);
              liveActivities.noteTool(chatId, summary === pending.name ? pending.name : `${pending.name} — ${summary}`);
            }
            const key = [...pendingToolCalls.entries()].find(([, call]) => call === pending)?.[0];
            if (key !== undefined) pendingToolCalls.delete(key);
          }
          sseWrite(res, "tool_result", { name: toolName, content: toolContent });
          if (tracksLiveActivity(source)) {
            streamingParagraph = "";
            liveActivities.noteTool(chatId, `${toolName} → ${toolContent.slice(0, 120)}`);
          }
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

        const text = messageContentToText(chunk.content);
        if (!text) continue;
        generatedChars += text.length;
        finalText += text;
        sseWrite(res, "text", { delta: text });
        if (tracksLiveActivity(source)) {
          streamingParagraph += text;
          liveActivities.noteMessage(chatId, streamingParagraph);
        }
      }

      const pendingApproval = await getPendingApproval(graph, chatId);
      if (pendingApproval) {
        debugLog(`approval required chat=${chatId} calls=${JSON.stringify(pendingApproval.calls.map((c) => c.name))}`);
        sseWrite(res, "approval_required", { calls: pendingApproval.calls });
        if (tracksLiveActivity(source)) liveActivities.awaitApproval(chatId);
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
        if (tracksLiveActivity(source)) liveActivities.finish(chatId, "completed");

        // Passive memory extraction (see userModelExtractor.ts) — never
        // awaited, never blocks the SSE response; only for an actual new
        // user message, not an approval-decision Command resume.
        if ("messages" in input) {
          const humanText = input.messages
            .map((m) => messageContentToText(m.content) || JSON.stringify(m.content))
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
      if (tracksLiveActivity(source)) liveActivities.finish(chatId, "failed", "Arrêté");
    } else {
      sseWrite(res, "error", { message: err instanceof Error ? err.message : String(err) });
      if (tracksLiveActivity(source)) liveActivities.finish(chatId, "failed", err instanceof Error ? err.message : "Erreur");
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
    chatEvents.append(chatId, "human", payload.source === "app" ? "app" : "cli", input);
    autoTitleChat(chats, chatId, input);
    if (taskMode === "goal") goals.set(chatId, input, config.goalMaxTurns);
    else goals.clear(chatId);
  }
  chats.touch(chatId);

  // Task mode applies to this request only. Clear the chat-scoped list at
  // the user-turn boundary so an interrupted or completed request cannot
  // make a new request resume an unrelated old plan. Approval resumes and
  // retries intentionally keep their existing list.
  if (!isRetry && (taskMode === "todo" || taskMode === "plan" || taskMode === "deep_research")) todos.clear(chatId);
  // Deep Research keeps its findings in their own table; a new question must
  // not synthesise over the previous one's notes.
  if (!isRetry && taskMode === "deep_research") research.clear(chatId);

  await streamGraphTurn(req, res, chatId, thinkingMode, taskMode, { messages: isRetry ? [] : [new HumanMessage(expandSkillMentions(input))] }, payload.source === "app" ? "app" : "cli");
  const exportedChat = chats.get(chatId);
  if (exportedChat) void maybeExportChat(graph, exportedChat);
}

// Resumes a thread paused on toolsNode's interrupt() (see graph.ts) with the
// user's per-call approve/deny decisions, then keeps streaming the rest of
// the turn — including a further approval_required if another destructive
// call follows immediately.
async function handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; thinking?: ThinkingMode; taskMode?: TaskMode; decisions?: ToolApprovalDecision; source?: ChatEventSource }>(req);
  if (!payload || !requireChat(res, payload.chatId)) return;
  const chatId = payload.chatId as string;
  if (!payload.decisions) {
    sendJson(res, 400, { error: "decisions is required" });
    return;
  }
  const thinkingMode: ThinkingMode = payload.thinking ?? "full";
  const taskMode: TaskMode = payload.taskMode ?? "none";
  await streamGraphTurn(req, res, chatId, thinkingMode, taskMode, new Command({ resume: payload.decisions }), payload.source === "app" ? "app" : "cli");
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

async function handleTranscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ audioBase64?: string; filename?: string; mimeType?: string; language?: string }>(req);
  if (!payload?.audioBase64 || !payload.filename || !payload.mimeType) {
    sendJson(res, 400, { error: "audioBase64, filename and mimeType are required" });
    return;
  }
  try {
    const text = await transcribeAudio({
      buffer: Buffer.from(payload.audioBase64, "base64"),
      filename: payload.filename,
      mimeType: payload.mimeType,
      language: payload.language,
    });
    sendJson(res, 200, { text });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
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
  sendJson(res, 200, { stopped: wasActive });
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

// ChatGPT device-code OAuth login (see src/core/llm/openaiAuth.ts's header
// comment for the verified flow) — same start/background-loop/status shape
// already used for the server's asynchronous flows, reused here rather than
// inventing a new pattern. A login is global (one ULTRON
// install, one ChatGPT account), not per-chat, so every interface (CLI,
// web, mobile) hitting these same routes shares one outcome.
interface OpenAILoginState {
  status: "pending" | "complete" | "error";
  error?: string;
}
const openaiLogins = new Map<string, OpenAILoginState>();

async function handleOpenAILoginStart(res: ServerResponse): Promise<void> {
  let session: DeviceCodeSession;
  try {
    session = await requestDeviceCode();
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const loginId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  openaiLogins.set(loginId, { status: "pending" });
  void pollAndExchange(session)
    .then((tokens) => {
      const accountEmail = tokens.idToken ? decodeAccountEmail(tokens.idToken) : null;
      const accountId = tokens.idToken ? decodeAccountId(tokens.idToken) : null;
      openaiAuth.save({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, idToken: tokens.idToken, accountEmail, accountId });
      openaiLogins.set(loginId, { status: "complete" });
    })
    .catch((err) => {
      openaiLogins.set(loginId, { status: "error", error: err instanceof Error ? err.message : String(err) });
    });
  sendJson(res, 200, { loginId, verificationUrl: session.verificationUrl, userCode: session.userCode });
}

async function handleOpenAILoginStatus(res: ServerResponse, loginId: string | null): Promise<void> {
  const state = loginId ? openaiLogins.get(loginId) : undefined;
  if (!state) {
    sendJson(res, 404, { error: "unknown or expired login attempt" });
    return;
  }
  sendJson(res, 200, state);
}

async function handleOpenAIStatus(res: ServerResponse): Promise<void> {
  const stored = openaiAuth.get();
  sendJson(res, 200, { authenticated: Boolean(stored), accountEmail: stored?.accountEmail ?? null });
}

async function handleOpenAILogout(res: ServerResponse): Promise<void> {
  const stored = openaiAuth.get();
  if (stored) await revokeOpenAI(stored.accessToken);
  openaiAuth.clear();
  sendJson(res, 200, { loggedOut: true });
}

// Lightweight liveness probe — a real (cheap) DB query but no LLM call — so
// anything that needs to know the process is up and the shared SQLite file
// is reachable (a supervisor script) doesn't have to
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

// What the mobile app polls when it returns to the foreground
// (`LiveActivityManager.reconcile`). A suspended app stops receiving its SSE
// stream, so its Live Activity freezes on a stale "running" state; this is how
// it finds out the turn actually finished. Returns 204 when the server knows
// nothing about a turn on that chat, which the client treats as "leave the
// activity alone".
function handleLiveActivityState(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const chatId = url.searchParams.get("chatId");
  if (!requireChat(res, chatId)) return;
  const state = liveActivities.getState(chatId);
  if (!state) {
    res.writeHead(204).end();
    return;
  }
  sendJson(res, 200, {
    status: state.status,
    entries: state.entries,
    startedAt: state.startedAt,
    running: state.running,
  });
}

async function handleLiveActivityRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ chatId?: string; activityId?: string; pushToken?: string }>(req);
  if (!payload?.chatId || !payload.activityId || !payload.pushToken || !chats.get(payload.chatId)) {
    sendJson(res, 400, { error: "chatId, activityId and pushToken are required" });
    return;
  }
  if (!/^[0-9a-f]+$/i.test(payload.pushToken)) {
    sendJson(res, 400, { error: "pushToken must be hexadecimal" });
    return;
  }
  liveActivities.register(payload.chatId, payload.activityId, payload.pushToken);
  sendJson(res, 200, { registered: true });
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

// Web-UI parity for the CLI /memory command (passive user-model
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

async function handleReasoning(url: URL, res: ServerResponse): Promise<void> {
  const provider = url.searchParams.get("provider") ?? config.provider;
  const model = url.searchParams.get("model") ?? config.nemotronModel;
  if (provider !== "nvidia" && provider !== "deepseek" && provider !== "groq" && provider !== "openai") {
    sendJson(res, 400, { error: "invalid provider" });
    return;
  }
  sendJson(res, 200, await getReasoningProfile(provider, model));
}

async function handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJson<{ model?: string; provider?: string }>(req);
  const model = payload?.model?.trim();
  if (!model) { sendJson(res, 400, { error: "model is required" }); return; }
  const provider = payload?.provider;
  if (provider !== undefined && provider !== "nvidia" && provider !== "deepseek" && provider !== "groq" && provider !== "openai") {
    sendJson(res, 400, { error: "invalid provider" });
    return;
  }
  if (provider && provider !== config.provider) {
    if (!hasProviderCredentials(provider)) {
      sendJson(res, 400, { error: provider === "openai" ? "not connected — configure OpenAI first" : `${provider.toUpperCase()}_API_KEY is not set` });
      return;
    }
    setActiveProvider(provider);
  }
  const selected = await resolveModelContext<ModelInfo>({ id: model });
  setActiveModel(model);
  config.contextWindowTokens = selected.contextWindowTokens ?? fallbackContextWindowTokens;
  graph = buildGraph();
  sendJson(res, 200, { provider: config.provider, model });
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
  if (provider !== "nvidia" && provider !== "deepseek" && provider !== "groq" && provider !== "openai") { sendJson(res, 400, { error: "provider must be nvidia, deepseek, groq or openai" }); return; }
  if (!hasProviderCredentials(provider)) {
    sendJson(res, 400, { error: provider === "openai" ? 'not connected — POST /api/openai/login/start first' : `${provider.toUpperCase()}_API_KEY is not set` });
    return;
  }
  setActiveProvider(provider);
  const models = await listAvailableModels();
  const currentModel = models.find((m) => m.id === config.nemotronModel);
  config.contextWindowTokens = (currentModel ? await resolveModelContext(currentModel) : undefined)?.contextWindowTokens ?? fallbackContextWindowTokens;
  graph = buildGraph();
  sendJson(res, 200, { provider: config.provider, model: config.nemotronModel });
}

async function handleSchedules(res: ServerResponse): Promise<void> { sendJson(res, 200, { schedules: schedules.listSchedules() }); }
async function handleCreateSchedule(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const p = await readJson<{ name?: string; instruction?: string; cron?: string; timezone?: string }>(req);
  if (!p?.name?.trim() || !p.instruction?.trim() || !p.cron?.trim()) { sendJson(res, 400, { error: "name, instruction and cron are required" }); return; }
  try { sendJson(res, 200, { schedule: schedules.createSchedule({ ...p, name: p.name.trim(), instruction: p.instruction.trim(), cron: p.cron.trim() }) }); } catch (err) { sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
}
async function handleScheduleAction(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> { const p = await readJson<{ enabled?: boolean }>(req); schedules.setScheduleEnabled(id, p?.enabled === true); sendJson(res, 200, { schedules: schedules.listSchedules() }); }
async function handleDeleteSchedule(res: ServerResponse, id: string): Promise<void> { schedules.deleteSchedule(id); sendJson(res, 200, { deleted: true }); }

async function runDueSchedules(): Promise<void> {
  schedules.cleanupCompletedSchedules();
  for (const task of schedules.getDueSchedules()) {
    debugLog(`scheduler picked id=${task.id} name=${task.name}`);
    schedules.markRun(task.id);
    const execution = chats.create(`Scheduled: ${task.name}`, task.id);
    schedules.setLastRunChat(task.id, execution.id);
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
  const chatMatch = path.match(/^\/api\/chats\/([^/]+)(\/messages|\/events|\/todos|\/archive|\/resume|\/export|\/upload|\/project)?$/);

  if (req.method === "GET" && path === "/api/chats") {
    handleListChats(res).catch((err) => console.error("[ultron-web] list chats failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/projects") {
    handleListProjects(res).catch((err) => console.error("[ultron-web] list projects failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/projects") {
    handleCreateProject(req, res).catch((err) => console.error("[ultron-web] create project failed:", err));
    return;
  }
  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === "PATCH") {
    handleUpdateProject(req, res, decodeURIComponent(projectMatch[1])).catch((err) => console.error("[ultron-web] update project failed:", err));
    return;
  }
  if (projectMatch && req.method === "DELETE") {
    handleDeleteProject(res, decodeURIComponent(projectMatch[1])).catch((err) => console.error("[ultron-web] delete project failed:", err));
    return;
  }
  if (chatMatch && chatMatch[2] === "/project" && req.method === "PATCH") {
    handleSetChatProject(req, res, decodeURIComponent(chatMatch[1])).catch((err) => console.error("[ultron-web] set chat project failed:", err));
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
  if (req.method === "POST" && path === "/api/openai/login/start") {
    handleOpenAILoginStart(res).catch((err) => console.error("[ultron-web] openai login start failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/openai/login/status") {
    handleOpenAILoginStatus(res, url.searchParams.get("loginId")).catch((err) => console.error("[ultron-web] openai login status failed:", err));
    return;
  }
  if (req.method === "GET" && path === "/api/openai/status") {
    handleOpenAIStatus(res).catch((err) => console.error("[ultron-web] openai status failed:", err));
    return;
  }
  if (req.method === "POST" && path === "/api/openai/logout") {
    handleOpenAILogout(res).catch((err) => console.error("[ultron-web] openai logout failed:", err));
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
  if (req.method === "POST" && path === "/api/transcribe") {
    handleTranscription(req, res).catch((err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }));
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
  if (req.method === "GET" && path === "/api/reasoning") {
    handleReasoning(url, res).catch((err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }));
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
  if (req.method === "POST" && path === "/api/live-activities/register") {
    handleLiveActivityRegister(req, res).catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (req.method === "GET" && path === "/api/live-activities/state") {
    handleLiveActivityState(req, res);
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
