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
  pickArchivedChat,
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
  type NvidiaModelInfo,
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

// Satisfies ui.ts's ArchivedChatSource — the remote equivalent of passing
// ChatRegistry directly in the local CLI.
const archivedChatSource = {
  listArchived: async (): Promise<Chat[]> => (await apiGet("/api/chats/archived")).chats,
  delete: async (id: string): Promise<void> => { await apiDelete(`/api/chats/${encodeURIComponent(id)}`); },
};

async function main() {
  try {
    await apiGet("/api/health");
  } catch {
    console.error(chalk.red(`Could not reach ULTRON at ${SERVER_URL} — is the server running there?`));
    process.exit(1);
  }

  let currentChatId: string;
  let currentChatTitle: string;
  {
    const { chats } = await apiGet("/api/chats");
    const focus = await apiGet("/api/focus");
    const chat: Chat | undefined = focus.chat ?? chats[0];
    if (chat) {
      currentChatId = chat.id;
      currentChatTitle = chat.title;
    } else {
      const created = await apiPost("/api/chats");
      currentChatId = created.chat.id;
      currentChatTitle = created.chat.title;
    }
  }

  let eventCursor = 0;
  let eventPollTimer: ReturnType<typeof setInterval> | undefined;
  let eventPollBusy = false;
  let currentContextLine = "";
  let modelName = "";
  let toolCount = 0;

  const syncEventCursor = async (): Promise<void> => {
    const data = await apiGet(`/api/chats/${encodeURIComponent(currentChatId)}/events?after=9007199254740991`);
    eventCursor = data.latestId ?? eventCursor;
  };

  const syncFocusedChat = async (): Promise<boolean> => {
    const data = await apiGet("/api/focus");
    const focused = data.chat as Chat | undefined;
    if (!focused || focused.id === currentChatId) return false;
    currentChatId = focused.id;
    currentChatTitle = focused.title;
    await syncEventCursor();
    setActivePermissionLabel(focused.securityMode);
    const history = await apiGet(`/api/chats/${encodeURIComponent(currentChatId)}/messages`);
    showRestoredMessages(history.messages as ChatMessage[], modelName);
    appendTranscript(uiDim(`[ultron] switched to "${focused.title}" from the other interface.\n\n`));
    return true;
  };

  const pollExternalEvents = async (): Promise<void> => {
    if (eventPollBusy) return;
    eventPollBusy = true;
    try {
      if (await syncFocusedChat()) return;
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
    appendTranscript(uiDim("[ultron] loading NVIDIA models…\n"));
    renderScreen("", 0, contextLine);
    flushRender();
    try {
      const data = await apiGet("/api/models");
      const models: NvidiaModelInfo[] = data.models;
      if (models.length === 0) {
        appendTranscript(chalk.yellow("[ultron] NVIDIA returned no models.\n\n"));
        return;
      }
      const selected = await pickModel(contextLine, models, data.current);
      if (!selected) return;
      if (selected.id === data.current) return;
      await apiPatch("/api/model", { model: selected.id });
      await refreshStatus();
      const contextLabel = selected.contextWindowTokens
        ? ` · context ${selected.contextWindowTokens.toLocaleString()} tokens`
        : " · context fallback in use";
      appendTranscript(uiDim(`[ultron] model set to ${selected.id}${contextLabel}.\n\n`));
    } catch (error) {
      appendTranscript(chalk.red(`[ultron] could not list NVIDIA models: ${error instanceof Error ? error.message : String(error)}\n\n`));
    }
  };

  const deleteCurrentChat = async (): Promise<void> => {
    const chats = (await apiGet("/api/chats")).chats as Chat[];
    const current = chats.find((chat) => chat.id === currentChatId);
    if (!current) {
      appendTranscript(chalk.yellow("[ultron] current conversation is no longer registered.\n\n"));
      return;
    }
    try {
      await apiDelete(`/api/chats/${encodeURIComponent(currentChatId)}`);
    } catch (error) {
      appendTranscript(chalk.yellow(`[ultron] ${error instanceof Error ? error.message : String(error)}.\n\n`));
      return;
    }
    await switchToMain();
    setTranscript("");
    printBanner(modelName);
    appendTranscript(uiDim(`[ultron] deleted "${current.title}". Memory preserved. Returned to main.\n\n`));
  };

  const resumeChat = async (contextLine: string, commandArgument: string): Promise<void> => {
    let target: Chat | undefined;
    if (!commandArgument) {
      target = await pickArchivedChat(contextLine, archivedChatSource);
    } else {
      const query = commandArgument.toLowerCase();
      const archived: Chat[] = await archivedChatSource.listArchived();
      target = archived.find((chat) => chat.id === commandArgument || chat.title.toLowerCase().includes(query));
    }
    if (!target) {
      appendTranscript(chalk.yellow("[ultron] no archived chat selected.\n\n"));
      return;
    }
    currentChatId = target.id;
    currentChatTitle = target.title;
    await syncEventCursor();
    setActivePermissionLabel(target.securityMode);
    const { messages } = await apiGet(`/api/chats/${encodeURIComponent(currentChatId)}/messages`);
    showRestoredMessages(messages as ChatMessage[], modelName);
    appendTranscript(uiDim(`[ultron] resumed "${target.title}".\n\n`));
  };

  const switchToMain = async (): Promise<void> => {
    const data = await apiPost("/api/main");
    currentChatId = data.chat.id;
    currentChatTitle = data.chat.title;
    await syncEventCursor();
    setActivePermissionLabel(data.chat.securityMode);
    const { messages } = await apiGet(`/api/chats/${encodeURIComponent(currentChatId)}/messages`);
    showRestoredMessages(messages as ChatMessage[], modelName);
    appendTranscript(uiDim("[ultron] switched to main conversation.\n\n"));
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
    await syncFocusedChat();
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
          case "/status": {
            const chat = (await apiGet("/api/chats")).chats.find((c: Chat) => c.id === currentChatId);
            printStatus(modelName, toolCount, thinkingMode, taskMode, verbose, currentChatId, chat?.securityMode ?? "bypass", status.goal ?? undefined);
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
          case "/resume":
            await resumeChat(contextLine, commandArgument);
            continue;
          case "/main":
            await switchToMain();
            continue;
          case "/delete":
            await deleteCurrentChat();
            continue;
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
            if (commandName === "/resume") { await resumeChat(contextLine, commandArgument); continue; }
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
