import { createReadStream, existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HumanMessage } from "@langchain/core/messages";
import { archiveThread, buildGraph, compactThread, estimateContextUsage, prepareRetry, resumeThread } from "../agent/graph.js";
import { config } from "../config.js";
import type { ThinkingMode } from "../llm/nemotron.js";
import { tools } from "../tools/index.js";
import { summarizeToolCall } from "../tools/summarize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

// Same thread id as the CLI ("ultron-main") — both point buildGraph() at
// the same SqliteSaver database file (see src/memory/checkpointer.ts), so
// a message sent from one interface shows up in the other's history too.
const THREAD_ID = "ultron-main";
const graph = buildGraph();

// Single-user local tool: one generation at a time, mirroring the CLI's
// single-session model. No per-client session tracking.
let activeAbort: AbortController | undefined;

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

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const safePath = normalize(url).replace(/^(\.\.[/\\])+/, "");
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

async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let payload: { text?: string; thinking?: ThinkingMode; retry?: boolean };
  try {
    payload = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  const thinkingMode: ThinkingMode = payload.thinking ?? "full";
  const isRetry = payload.retry === true;
  let input = payload.text ?? "";

  if (isRetry) {
    const retryInput = await prepareRetry(graph, THREAD_ID);
    if (!retryInput) {
      sendJson(res, 400, { error: "nothing to retry yet" });
      return;
    }
    input = retryInput;
  } else if (!input.trim()) {
    sendJson(res, 400, { error: "message text is required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  activeAbort?.abort();
  const abortController = new AbortController();
  activeAbort = abortController;

  req.on("close", () => {
    if (activeAbort === abortController) abortController.abort();
  });

  const turnStarted = Date.now();

  try {
    const stream = await graph.stream(
      { messages: isRetry ? [] : [new HumanMessage(input)] },
      {
        configurable: { thread_id: THREAD_ID, thinking: thinkingMode },
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
    const contextTokens = await estimateContextUsage(graph, THREAD_ID);
    sseWrite(res, "done", { elapsedSeconds, generatedTokens, contextTokens, maxTokens: config.contextWindowTokens });
  } catch (err) {
    if (abortController.signal.aborted) {
      sseWrite(res, "aborted", {});
    } else {
      sseWrite(res, "error", { message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (activeAbort === abortController) activeAbort = undefined;
    res.end();
  }
}

async function handleStop(res: ServerResponse): Promise<void> {
  const wasActive = !!activeAbort;
  activeAbort?.abort();
  sendJson(res, 200, { stopped: wasActive });
}

async function handleCompact(res: ServerResponse): Promise<void> {
  const result = await compactThread(graph, THREAD_ID);
  sendJson(res, 200, result);
}

async function handleArchive(res: ServerResponse): Promise<void> {
  const path = await archiveThread(graph, THREAD_ID);
  sendJson(res, 200, { path });
}

async function handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let payload: { path?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (!payload.path) {
    sendJson(res, 400, { error: "archive path is required" });
    return;
  }
  try {
    const count = await resumeThread(graph, THREAD_ID, payload.path);
    sendJson(res, 200, { count });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleStatus(res: ServerResponse): Promise<void> {
  const contextTokens = await estimateContextUsage(graph, THREAD_ID);
  sendJson(res, 200, {
    model: config.nemotronModel,
    toolCount: tools.length,
    contextTokens,
    maxTokens: config.contextWindowTokens,
  });
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (req.method === "POST" && url === "/api/turn") {
    handleTurn(req, res).catch((err) => {
      console.error("[ultron-web] turn handler failed:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
    return;
  }
  if (req.method === "POST" && url === "/api/stop") {
    handleStop(res).catch((err) => console.error("[ultron-web] stop handler failed:", err));
    return;
  }
  if (req.method === "POST" && url === "/api/compact") {
    handleCompact(res).catch((err) => console.error("[ultron-web] compact handler failed:", err));
    return;
  }
  if (req.method === "POST" && url === "/api/archive") {
    handleArchive(res).catch((err) => console.error("[ultron-web] archive handler failed:", err));
    return;
  }
  if (req.method === "POST" && url === "/api/resume") {
    handleResume(req, res).catch((err) => console.error("[ultron-web] resume handler failed:", err));
    return;
  }
  if (req.method === "GET" && url === "/api/status") {
    handleStatus(res).catch((err) => console.error("[ultron-web] status handler failed:", err));
    return;
  }
  if (req.method === "GET" && serveStatic(req, res)) return;

  sendJson(res, 404, { error: "not found" });
});

server.listen(config.webPort, () => {
  console.log(`[ultron-web] listening on http://localhost:${config.webPort}`);
});
