#!/usr/bin/env node
// Network client: talks to a ULTRON web server (src/interfaces/web/server.ts)
// over HTTP/SSE instead of running buildGraph() in-process — the "ultron"
// command meant to run on the Mac while the actual graph/tools/memory live
// on the Jetson. Shares every rendering primitive with the local CLI
// (./ui.ts) so the two look and behave identically; only how a turn
// actually gets executed differs. Deliberately does NOT import ../../config.js
// or ../../core/graph.js as values (only as `import type` inside ui.ts,
// which is erased at compile time): those pull in NVIDIA_API_KEY/
// DATABASE_PATH validation that has no reason to exist on a machine that
// never touches the model or the database directly. The only required
// input is the server's URL.
import "dotenv/config";
import { stdout } from "node:process";
import chalk from "chalk";
import type { ChatMessage, TaskMode } from "../../core/graph.js";
import type { Chat, SecurityMode } from "../../core/memory/chats.js";
import type { Goal } from "../../core/memory/goals.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import type { LlmProvider } from "../../config.js";
import { MarkdownStreamRenderer } from "./markdown.js";
import {
  appendTranscript,
  armStopCommand,
  cancelActiveInput,
  collapseDanglingToolBlock,
  expandSkillMentions,
  flushRender,
  formatToolResult,
  initResizeHandler,
  isLightTerminal,
  markDanglingToolBlock,
  pickModel,
  pickPermission,
  printBanner,
  printHelp,
  printStatus,
  promptToolApproval,
  readInput,
  renderContextBar,
  renderScreen,
  setActiveModeLabel,
  setActivePermissionLabel,
  setDanglingToolBlock,
  setGenerationInput,
  setTerminalTheme,
  setTranscript,
  showRestoredMessages,
  transcript,
  uiDim,
  writeLive,
  type ModelChoice,
  type PendingToolCall,
} from "./ui.js";

const SERVER_URL = (process.env.ULTRON_SERVER_URL ?? "").replace(/\/+$/, "");
if (!SERVER_URL) {
  console.error(
    "Missing ULTRON_SERVER_URL — set it to the ULTRON web server's address, " +
      "e.g. export ULTRON_SERVER_URL=http://100.114.144.1:4173 (see .env.example).",
  );
  process.exit(1);
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`);
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data.error ?? `${path} → HTTP ${res.status}`);
  return data;
}

async function apiPost(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data.error ?? `${path} → HTTP ${res.status}`);
  return data;
}

async function apiPatch(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data.error ?? `${path} → HTTP ${res.status}`);
  return data;
}

async function apiDelete(path: string): Promise<void> {
  const response = await fetch(`${SERVER_URL}${path}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `${path} → HTTP ${response.status}`);
  }
}

async function main() {
  try {
    await apiGet("/api/health");
  } catch {
    console.error(chalk.red(`Could not reach ULTRON at ${SERVER_URL} — is the server running there?`));
    process.exit(1);
  }

  // Pure chat terminal on the shared "cli" Main conversation — no
  // /resume/main/delete here, conversation management lives exclusively on
  // the mobile app (and the web UI's own sidebar). Always the same chat.
  let currentChatId: string;
  let currentChatTitle: string;
  {
    const { chat } = await apiPost("/api/main");
    currentChatId = chat.id;
    currentChatTitle = chat.title;
  }

  let eventCursor = 0;
  let eventPollTimer: ReturnType<typeof setInterval> | undefined;
  let eventPollBusy = false;
  let currentContextLine = "";
  let modelName = "";
  let providerName: LlmProvider = "nvidia";
  let toolCount = 0;

  const syncEventCursor = async (): Promise<void> => {
    const data = await apiGet(`/api/chats/${encodeURIComponent(currentChatId)}/events?after=9007199254740991`);
    eventCursor = data.latestId ?? eventCursor;
  };

  const pollExternalEvents = async (): Promise<void> => {
    if (eventPollBusy) return;
    eventPollBusy = true;
    try {
      const data = await apiGet(`/api/chats/${encodeURIComponent(currentChatId)}/events?after=${eventCursor}`);
      for (const event of data.events ?? []) {
        eventCursor = Math.max(eventCursor, event.id);
        if (event.source === "cli") continue;
        const speaker = event.kind === "human" ? chalk.yellow("telegram") : chalk.redBright.bold("ultron");
        appendTranscript(`${speaker} ${uiDim("›")} ${event.content}\n\n`);
      }
      eventCursor = Math.max(eventCursor, data.latestId ?? eventCursor);
      if ((data.events ?? []).length) renderScreen("", 0, currentContextLine);
    } catch {
      // A temporary network failure must not interrupt the interactive CLI.
    } finally {
      eventPollBusy = false;
    }
  };

  await syncEventCursor();
  eventPollTimer = setInterval(() => { void pollExternalEvents(); }, 750);

  const refreshStatus = async (): Promise<{ contextTokens: number; maxTokens: number; goal: Goal | null }> => {
    const data = await apiGet(`/api/status?chatId=${encodeURIComponent(currentChatId)}`);
    modelName = data.model;
    providerName = data.provider ?? providerName;
    toolCount = data.toolCount;
    return data;
  };
  await refreshStatus();
  setActivePermissionLabel((await apiGet("/api/chats")).chats.find((c: Chat) => c.id === currentChatId)?.securityMode ?? "bypass");

  printBanner(modelName);
  initResizeHandler(() => modelName);

  let abortController: AbortController | undefined;
  let stopping = false;
  let thinkingMode: ThinkingMode = "full";
  let taskMode: TaskMode = "none";
  let verbose = false;

  const changeModel = async (contextLine: string): Promise<void> => {
    appendTranscript(uiDim("[ultron] loading models…\n"));
    renderScreen("", 0, contextLine);
    flushRender();
    try {
      const data = await apiGet("/api/models/grouped");
      const groups: { provider: LlmProvider; models: { id: string; contextWindowTokens?: number }[] }[] = data.groups;
      const flat: ModelChoice[] = groups.flatMap((g) => g.models.map((m) => ({ ...m, provider: g.provider })));
      if (flat.length === 0) {
        appendTranscript(chalk.yellow("[ultron] no models available.\n\n"));
        return;
      }
      const selected = await pickModel(contextLine, flat, modelName, providerName);
      if (!selected) return;
      if (selected.id === modelName && selected.provider === providerName) return;
      if (selected.provider !== providerName) await apiPatch("/api/provider", { provider: selected.provider });
      await apiPatch("/api/model", { model: selected.id });
      const status = await refreshStatus();
      appendTranscript(uiDim(`[ultron] model set to ${selected.provider}/${selected.id} · context ${status.maxTokens.toLocaleString()} tokens.\n\n`));
    } catch (error) {
      appendTranscript(chalk.red(`[ultron] could not list models: ${error instanceof Error ? error.message : String(error)}\n\n`));
    }
  };

  const PROVIDER_ORDER: LlmProvider[] = ["nvidia", "deepseek", "groq", "openai"];

  const changeProvider = async (contextLine: string, explicit?: LlmProvider): Promise<void> => {
    try {
      const data = await apiGet("/api/provider");
      const configured: LlmProvider[] = data.configured ?? ["nvidia"];
      let next: LlmProvider | undefined = explicit;
      if (next && !configured.includes(next)) {
        const hint = next === "openai" ? 'not connected on the server — run "/login openai" first' : `${next.toUpperCase()}_API_KEY is not set on the server`;
        appendTranscript(chalk.red(`[ultron] ${hint} — cannot switch to ${next}.\n\n`));
        renderScreen("", 0, contextLine);
        return;
      }
      if (!next) {
        const startIndex = PROVIDER_ORDER.indexOf(data.current);
        for (let step = 1; step <= PROVIDER_ORDER.length; step++) {
          const candidate = PROVIDER_ORDER[(startIndex + step) % PROVIDER_ORDER.length];
          if (configured.includes(candidate)) {
            next = candidate;
            break;
          }
        }
        next ??= "nvidia";
      }
      await apiPatch("/api/provider", { provider: next });
      await refreshStatus();
      printBanner(modelName);
      appendTranscript(uiDim(`[ultron] provider set to ${next} (model: ${modelName}).\n\n`));
    } catch (error) {
      appendTranscript(chalk.red(`[ultron] could not switch provider: ${error instanceof Error ? error.message : String(error)}\n\n`));
    }
  };

  // /login openai — kicks off the server's device-code OAuth flow (see
  // core/llm/openaiAuth.ts's header comment for the verified flow) and
  // polls its status; the server does the actual polling/exchange, this
  // just waits for the outcome. A login is global, not per-interface.
  const loginOpenAI = async (contextLine: string): Promise<void> => {
    try {
      const start = await apiPost("/api/openai/login/start");
      appendTranscript(
        uiDim(`[ultron] open ${chalk.cyanBright(start.verificationUrl)} and enter code ${chalk.cyanBright(start.userCode)} (expires in 15 min)…\n\n`),
      );
      renderScreen("", 0, contextLine);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await apiGet(`/api/openai/login/status?loginId=${encodeURIComponent(start.loginId)}`);
        if (status.status === "complete") {
          appendTranscript(uiDim("[ultron] connected to ChatGPT. Try /provider openai.\n\n"));
          return;
        }
        if (status.status === "error") {
          appendTranscript(chalk.red(`[ultron] ChatGPT login failed: ${status.error}\n\n`));
          return;
        }
      }
    } catch (error) {
      appendTranscript(chalk.red(`[ultron] ChatGPT login failed: ${error instanceof Error ? error.message : String(error)}\n\n`));
    }
    renderScreen("", 0, contextLine);
  };

  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    appendTranscript(uiDim("\n[ultron] stopping...\n"));
    abortController?.abort();
    apiPost("/api/stop", { chatId: currentChatId }).catch(() => {});
    cancelActiveInput?.();
  });

  // Consumes one SSE response to completion, recursing into /api/approve
  // when the stream ends on "approval_required" — same pattern as the web
  // UI's streamTurn (composer.js) and the local CLI's approval loop around
  // graph.stream(), just driven by pre-summarized server events instead of
  // raw LangGraph message chunks. The server also self-drives /task goal's
  // continuation loop inside this same SSE response (see server.ts's
  // streamGraphTurn), so "goal" events just need rendering here, not a
  // separate client-side judge/replay loop like the local CLI's
  // driveGoalLoop.
  async function pump(res: Response, contextLine: string): Promise<{ finalText: string; aborted: boolean; errored: boolean }> {
    let finalText = "";
    let aborted = false;
    let errored = false;
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: "request failed" }))) as { error?: string };
      appendTranscript(chalk.red(`[ultron] ${err.error ?? "request failed"}\n\n`));
      renderScreen("", 0, contextLine);
      return { finalText, aborted, errored: true };
    }
    if (!res.body) return { finalText, aborted, errored };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let wrotePrefix = false;
    const markdown = new MarkdownStreamRenderer();
    // Tool calls arrive as a separate "tool_call" event before their
    // matching "tool_result" — queued by name (FIFO) to mirror the local
    // CLI's pendingToolCalls bookkeeping, so a result writes its call's
    // summary immediately before the formatted result, then marks the
    // block dangling exactly like a local turn does.
    const pendingSummaries: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const raw of events) {
        const lines = raw.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) continue;
        const eventName = eventLine.slice("event: ".length);
        const data = JSON.parse(dataLine.slice("data: ".length));

        if (eventName === "text") {
          if (!wrotePrefix) {
            collapseDanglingToolBlock();
            writeLive(`${chalk.redBright.bold("ultron")} ${uiDim("›")} `, contextLine);
            wrotePrefix = true;
          }
          writeLive(markdown.push(data.delta), contextLine);
          finalText += data.delta;
        } else if (eventName === "tool_call") {
          if (wrotePrefix) {
            writeLive("\n\n", contextLine);
            wrotePrefix = false;
          }
          collapseDanglingToolBlock();
          pendingSummaries.push(data.summary);
        } else if (eventName === "tool_result") {
          collapseDanglingToolBlock();
          const blockStart = transcript.length;
          const summary = pendingSummaries.shift();
          if (summary) writeLive(uiDim(`[${summary}]\n`), contextLine);
          writeLive(`${formatToolResult(data.name, data.content)}\n\n`, contextLine);
          markDanglingToolBlock(blockStart, data.name);
        } else if (eventName === "approval_required") {
          if (wrotePrefix) {
            writeLive("\n", contextLine);
            wrotePrefix = false;
          }
          const decisions = await promptToolApproval(contextLine, data.calls as PendingToolCall[]);
          const next = await fetch(`${SERVER_URL}/api/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: currentChatId, thinking: thinkingMode, taskMode, decisions }),
            signal: abortController?.signal,
          });
          const nested = await pump(next, contextLine);
          finalText += nested.finalText;
          if (nested.aborted) aborted = true;
          if (nested.errored) errored = true;
        } else if (eventName === "done") {
          appendTranscript(markdown.flush());
          appendTranscript("\n\n");
          if (verbose) appendTranscript(uiDim(`  ${data.stats}\n\n`));
          renderScreen("", 0, contextLine);
        } else if (eventName === "goal") {
          appendTranscript(uiDim(`[ultron] goal ${data.status}${data.reason ? ` — ${data.reason}` : ""}\n\n`));
          renderScreen("", 0, contextLine);
        } else if (eventName === "aborted") {
          appendTranscript(uiDim("[ultron] generation stopped.\n\n"));
          renderScreen("", 0, contextLine);
          aborted = true;
        } else if (eventName === "error") {
          appendTranscript(chalk.red(`[ultron] error: ${data.message}\n\n`));
          renderScreen("", 0, contextLine);
          errored = true;
        }
      }
    }
    return { finalText, aborted, errored };
  }

  async function executeTurn(contextLine: string, body: { text?: string; retry?: boolean }): Promise<{ finalText: string; aborted: boolean; errored: boolean }> {
    collapseDanglingToolBlock();
    abortController = new AbortController();
    const controller = abortController;
    setGenerationInput("", 0);
    const disarmStopCommand = armStopCommand(controller, contextLine);
    try {
      const res = await fetch(`${SERVER_URL}/api/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: currentChatId, thinking: thinkingMode, taskMode, ...body }),
        signal: controller.signal,
      });
      // Passive memory extraction (userModelExtractor.ts) already runs
      // server-side inside handleTurn for every real user message — nothing
      // to replicate here, unlike the local CLI which calls it directly.
      return await pump(res, contextLine);
    } catch (err) {
      if (controller.signal.aborted) {
        appendTranscript(uiDim("[ultron] generation stopped.\n\n"));
        renderScreen("", 0, contextLine);
        return { finalText: "", aborted: true, errored: false };
      }
      appendTranscript(chalk.red(`[ultron] connection error: ${err instanceof Error ? err.message : String(err)}\n\n`));
      renderScreen("", 0, contextLine);
      return { finalText: "", aborted: false, errored: true };
    } finally {
      disarmStopCommand();
    }
  }

  try {
    while (!stopping) {
      const status = await refreshStatus();
      const contextLine = renderContextBar(status.contextTokens, status.maxTokens);
      currentContextLine = contextLine;
      let input = await readInput(contextLine);
      if (stopping) break;
      if (!input.trim()) continue;

      const rawInput = input.trim();
      const commandName = rawInput.split(/\s+/, 1)[0].toLowerCase();
      const command = rawInput.toLowerCase();
      const commandArgument = rawInput.slice(commandName.length).trim();
      let isRetry = false;

      if (command.startsWith("/")) {
        switch (command) {
          case "/help":
            printHelp();
            continue;
          case "/model":
            await changeModel(contextLine);
            continue;
          case "/provider":
            await changeProvider(contextLine);
            continue;
          case "/status": {
            const chat = (await apiGet("/api/chats")).chats.find((c: Chat) => c.id === currentChatId);
            printStatus(modelName, toolCount, thinkingMode, taskMode, verbose, currentChatId, chat?.securityMode ?? "bypass", status.goal ?? undefined, providerName);
            continue;
          }
          case "/context":
            appendTranscript(`${renderContextBar(status.contextTokens, status.maxTokens)}\n\n`);
            continue;
          case "/stop":
            appendTranscript(uiDim("[ultron] no active generation to stop.\n\n"));
            continue;
          case "/retry":
            isRetry = true;
            break;
          case "/compact": {
            const result = await apiPost("/api/compact", { chatId: currentChatId });
            appendTranscript(
              result.compacted
                ? uiDim(`[ultron] compacted ${result.before} messages into ${result.after} context messages.\n\n`)
                : uiDim("[ultron] not enough history to compact yet.\n\n"),
            );
            continue;
          }
          case "/think":
            appendTranscript(uiDim(`[ultron] reasoning mode: ${thinkingMode} (use /think on|low|off).\n\n`));
            continue;
          case "/task":
            appendTranscript(uiDim(`[ultron] task mode: ${taskMode} (use /task none|todo|plan|goal).\n\n`));
            continue;
          case "/security": {
            const chat = (await apiGet("/api/chats")).chats.find((c: Chat) => c.id === currentChatId);
            appendTranscript(uiDim(`[ultron] tool approval: ${chat?.securityMode ?? "bypass"} (use /security bypass|accept_edit|manual).\n\n`));
            continue;
          }
          case "/permissions": {
            const chat = (await apiGet("/api/chats")).chats.find((c: Chat) => c.id === currentChatId);
            const selectedPermission = await pickPermission(contextLine, chat?.securityMode ?? "bypass");
            if (!selectedPermission) {
              appendTranscript(uiDim("[ultron] permissions unchanged.\n\n"));
              continue;
            }
            await apiPatch(`/api/chats/${encodeURIComponent(currentChatId)}/security`, { mode: selectedPermission });
            setActivePermissionLabel(selectedPermission);
            appendTranscript(uiDim(`[ultron] permission mode set to ${selectedPermission}.\n\n`));
            continue;
          }
          case "/verbose":
            appendTranscript(uiDim(`[ultron] verbose is ${verbose ? "on" : "off"} (use /verbose on|off).\n\n`));
            continue;
          case "/quit":
            stopping = true;
            continue;
          default:
            if (command.startsWith("/think ")) {
              const mode = command.slice("/think ".length).trim();
              if (mode === "on" || mode === "full") thinkingMode = "full";
              else if (mode === "low") thinkingMode = "low";
              else if (mode === "off") thinkingMode = "off";
              else { appendTranscript(chalk.yellow("[ultron] use /think on, /think low or /think off.\n\n")); continue; }
              appendTranscript(uiDim(`[ultron] reasoning mode set to ${thinkingMode}.\n\n`));
              continue;
            }
            if (command.startsWith("/task ")) {
              const mode = command.slice("/task ".length).trim();
              if (mode !== "none" && mode !== "todo" && mode !== "plan" && mode !== "goal") {
                appendTranscript(chalk.yellow("[ultron] use /task none, /task todo, /task plan or /task goal.\n\n"));
                continue;
              }
              taskMode = mode as TaskMode;
              setActiveModeLabel(mode === "todo" ? "To-Do" : mode === "plan" ? "Plan" : mode === "goal" ? "Goal" : "None");
              appendTranscript(uiDim(`[ultron] task mode set to ${taskMode}.\n\n`));
              continue;
            }
            if (command.startsWith("/security ")) {
              const mode = command.slice("/security ".length).trim();
              if (mode !== "bypass" && mode !== "accept_edit" && mode !== "manual") {
                appendTranscript(chalk.yellow("[ultron] use /security bypass, /security accept_edit or /security manual.\n\n"));
                continue;
              }
              await apiPatch(`/api/chats/${encodeURIComponent(currentChatId)}/security`, { mode });
              setActivePermissionLabel(mode as SecurityMode);
              appendTranscript(uiDim(`[ultron] tool approval set to ${mode}.\n\n`));
              continue;
            }
            if (command.startsWith("/provider ")) {
              const requested = command.slice("/provider ".length).trim();
              if (requested !== "nvidia" && requested !== "deepseek" && requested !== "groq" && requested !== "openai") {
                appendTranscript(chalk.yellow("[ultron] use /provider nvidia, /provider deepseek, /provider groq or /provider openai.\n\n"));
                continue;
              }
              await changeProvider(contextLine, requested);
              continue;
            }
            if (command === "/login openai") {
              await loginOpenAI(contextLine);
              continue;
            }
            if (command === "/theme") {
              appendTranscript(uiDim(`[ultron] terminal theme: (${isLightTerminal() ? "light" : "dark"} palette).\n\n`));
              continue;
            }
            if (command.startsWith("/theme ")) {
              const theme = command.slice("/theme ".length).trim();
              if (theme !== "auto" && theme !== "light" && theme !== "dark") {
                appendTranscript(chalk.yellow("[ultron] use /theme auto, /theme light or /theme dark.\n\n"));
                continue;
              }
              setTerminalTheme(theme);
              appendTranscript(uiDim(`[ultron] terminal theme set to ${theme} (${isLightTerminal() ? "light" : "dark"} palette).\n\n`));
              continue;
            }
            if (command === "/verbose on" || command === "/verbose true") { verbose = true; appendTranscript(uiDim("[ultron] verbose on.\n\n")); continue; }
            if (command === "/verbose off" || command === "/verbose false") { verbose = false; appendTranscript(uiDim("[ultron] verbose off.\n\n")); continue; }
            if (commandName === "/export") {
              const arg = commandArgument.trim();
              if (!arg) {
                const { path } = await apiGet(`/api/chats/${encodeURIComponent(currentChatId)}/export`);
                appendTranscript(
                  uiDim(
                    path
                      ? `[ultron] live export: ${path} (updates after every turn) — /export off to stop.\n\n`
                      : "[ultron] no live export active for this chat — /export [path] to start, /export off to stop.\n\n",
                  ),
                );
                continue;
              }
              if (arg.toLowerCase() === "off") {
                await apiDelete(`/api/chats/${encodeURIComponent(currentChatId)}/export`);
                appendTranscript(uiDim("[ultron] live export stopped (file left as-is).\n\n"));
                continue;
              }
              const { path } = await apiPost(`/api/chats/${encodeURIComponent(currentChatId)}/export`, arg === "on" ? {} : { path: arg });
              appendTranscript(uiDim(`[ultron] live export started: ${path} (updates after every turn).\n\n`));
              continue;
            }
            if (commandName === "/memory") {
              appendTranscript(chalk.yellow("[ultron] /memory isn't available from the remote CLI yet (no server endpoint) — use the local CLI on the machine running the graph.\n\n"));
              continue;
            }
            appendTranscript(chalk.yellow(`[ultron] unknown command: ${input.trim()} — try /help\n\n`));
            continue;
        }
      }

      const turnInput = isRetry ? { retry: true } : { text: expandSkillMentions(input) };
      await executeTurn(contextLine, turnInput);
    }
  } finally {
    if (eventPollTimer) clearInterval(eventPollTimer);
    cancelActiveInput?.();
    appendTranscript(uiDim("[ultron] stopped.\n"));
    stdout.write(uiDim("[ultron] stopped.\n"));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red("[ultron] fatal error:"), err);
  process.exit(1);
});
