import { stdout } from "node:process";
import chalk from "chalk";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import {
  buildGraph,
  compactThread,
  estimateContextUsage,
  getPendingApproval,
  listChatMessages,
  prepareRetry,
  type PendingToolCall,
  type TaskMode,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { withThreadLock } from "../../core/threadLock.js";
import { config } from "../../config.js";
import { formatTurnStats } from "../../core/llm/usage.js";
import { recordUserModelObservation } from "../../core/userModelExtractor.js";
import { getUserModelRegistry } from "../../core/memory/userModel.js";
import { getHealthRegistry, pickLatestWithData, sparkline, type HealthMetric } from "../../core/memory/health.js";
import { computeActivityScore, computeRecoveryScore } from "../../core/health/scoring.js";
import { detectAnomalies } from "../../core/health/trends.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { CLI_CHAT_SCOPE, getChatRegistry, LEGACY_CHAT_ID, type Chat } from "../../core/memory/chats.js";
import { defaultExportPath, maybeExportChat, resolveExportPath } from "../../core/memory/exporter.js";
import { getGoalRegistry } from "../../core/memory/goals.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { getChatEventRegistry } from "../../core/memory/chatEvents.js";
import { buildContinuationPrompt, gatherCodeContext, gatherHealthContext, judgeGoal } from "../../core/goalJudge.js";
import { disableConsoleEcho } from "../../core/logger.js";
import { tools } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
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
} from "./ui.js";

// Local CLI — runs the graph in-process (needs NVIDIA_API_KEY, opens the
// local SQLite file directly). See src/interfaces/cli/remote.ts for the
// network-client counterpart meant for a machine that only has
// ULTRON_SERVER_URL — the two share every rendering primitive (ui.ts) so
// they look and behave identically; only how a turn actually gets executed
// differs.

async function listNvidiaModels(): Promise<NvidiaModelInfo[]> {
  const baseUrl = config.nemotronBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.nvidiaApiKey}`,
    },
  });
  if (!response.ok) throw new Error(`NVIDIA returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: { id?: unknown; max_model_len?: unknown; max_context_length?: unknown }[];
  };
  return (payload.data ?? [])
    .map((model) => {
      if (typeof model.id !== "string" || !model.id) return undefined;
      const rawContext = model.max_model_len ?? model.max_context_length;
      const contextWindowTokens = typeof rawContext === "number"
        ? rawContext
        : typeof rawContext === "string" && /^\d+$/.test(rawContext)
          ? Number(rawContext)
          : undefined;
      return {
        id: model.id,
        ...(contextWindowTokens && Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0
          ? { contextWindowTokens }
          : {}),
      };
    })
    .filter((model): model is NvidiaModelInfo => Boolean(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const modelContextCache = new Map<string, number | undefined>();

async function resolveNvidiaModelContext(model: NvidiaModelInfo): Promise<NvidiaModelInfo> {
  if (model.contextWindowTokens) return model;
  if (modelContextCache.has(model.id)) {
    const contextWindowTokens = modelContextCache.get(model.id);
    return contextWindowTokens ? { ...model, contextWindowTokens } : model;
  }

  try {
    const modelPath = model.id.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`https://build.nvidia.com/${modelPath}/modelcard`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    // Hosted NIM's /v1/models omits max_model_len. The NVIDIA model card
    // exposes the same capability in its description (for example, "1M
    // context" or "1,000,000 tokens").
    const contextMatch = html.match(/(?:([\d][\d,.]*)\s*(million|[kKmM])\s*[- ]?token(?:s)?\s*context|context(?: window| length)?[^\d]{0,40}([\d][\d,.]*)\s*(million|[kKmM])?\s*token(?:s)?)/i);
    const value = contextMatch?.[1] ?? contextMatch?.[3];
    const unit = (contextMatch?.[2] ?? contextMatch?.[4] ?? "").toLowerCase();
    if (!value) {
      modelContextCache.set(model.id, undefined);
      return model;
    }
    const numeric = Number(value.replace(/,/g, ""));
    const multiplier = unit === "million" || unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
    const contextWindowTokens = numeric * multiplier;
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
      modelContextCache.set(model.id, undefined);
      return model;
    }
    modelContextCache.set(model.id, contextWindowTokens);
    return { ...model, contextWindowTokens };
  } catch {
    modelContextCache.set(model.id, undefined);
    return model;
  }
}

async function main() {
  // Must happen before anything else can log — the CLI owns raw-mode
  // terminal drawing from here on, and a stray console.error from
  // graph.ts/tools would otherwise land as garbage text spliced into the
  // middle of that live-rendered UI.
  disableConsoleEcho();
  printBanner(config.nemotronModel);
  initResizeHandler(() => config.nemotronModel);

  let graph = buildGraph();
  const chats = getChatRegistry(config.databasePath);
  const goals = getGoalRegistry(config.databasePath);
  const todos = getTodoRegistry(config.databasePath);
  const chatEvents = getChatEventRegistry(config.databasePath);
  // Registers the CLI's original hardcoded thread (from before chats
  // existed) so its history shows up in the registry instead of being
  // orphaned — same migration the web server runs on its own startup.
  chats.ensure(LEGACY_CHAT_ID);
  // CLI focus is deliberately independent from Telegram focus.
  let currentChatId = chats.getFocus(CLI_CHAT_SCOPE)?.id ?? chats.activateMain(CLI_CHAT_SCOPE).id;
  chats.setFocus(currentChatId, CLI_CHAT_SCOPE);
  setActivePermissionLabel(chats.getSecurityMode(currentChatId));

  // The local CLI shares the database with Telegram directly. Keep listening
  // to Telegram-originated events so /resume is live, not just a one-time
  // history restore.
  let eventCursor = chatEvents.latestId(currentChatId);
  let eventPollBusy = false;
  const pollTelegramEvents = async (): Promise<void> => {
    if (eventPollBusy) return;
    eventPollBusy = true;
    try {
      const events = chatEvents.listAfter(currentChatId, eventCursor);
      for (const event of events) {
        eventCursor = event.id;
        if (event.source !== "telegram") continue;
        const speaker = event.kind === "human" ? chalk.yellow("telegram") : chalk.redBright.bold("ultron");
        appendTranscript(`${speaker} ${uiDim("›")} ${event.content}\n\n`);
      }
      if (events.length) renderScreen("", 0, "");
    } finally {
      eventPollBusy = false;
    }
  };
  const eventPollTimer = setInterval(() => { void pollTelegramEvents(); }, 750);

  let abortController: AbortController | undefined;
  let stopping = false;
  let thinkingMode: ThinkingMode = "full";
  let taskMode: TaskMode = "none";
  let verbose = false;
  const fallbackContextWindowTokens = config.contextWindowTokens;

  const applyModelContext = (model: NvidiaModelInfo | undefined): void => {
    config.contextWindowTokens = model?.contextWindowTokens ?? fallbackContextWindowTokens;
  };

  const changeModel = async (contextLine: string): Promise<void> => {
    appendTranscript(uiDim("[ultron] loading NVIDIA models…\n"));
    renderScreen("", 0, contextLine);
    flushRender();
    try {
      const models = await listNvidiaModels();
      if (models.length === 0) {
        appendTranscript(chalk.yellow("[ultron] NVIDIA returned no models.\n\n"));
        return;
      }
      const selected = await pickModel(contextLine, models, config.nemotronModel);
      if (!selected) return;
      const resolvedSelected = await resolveNvidiaModelContext(selected);
      if (resolvedSelected.id === config.nemotronModel) {
        applyModelContext(resolvedSelected);
        return;
      }
      config.nemotronModel = resolvedSelected.id;
      applyModelContext(resolvedSelected);
      graph = buildGraph();
      const contextLabel = resolvedSelected.contextWindowTokens
        ? ` · context ${resolvedSelected.contextWindowTokens.toLocaleString()} tokens`
        : " · context fallback in use";
      appendTranscript(uiDim(`[ultron] model set to ${resolvedSelected.id}${contextLabel}.\n\n`));
    } catch (error) {
      appendTranscript(chalk.red(`[ultron] could not list NVIDIA models: ${error instanceof Error ? error.message : String(error)}\n\n`));
    }
  };

  // Use the served model's advertised limit for the initial context gauge as
  // well. If the endpoint is unavailable or omits the field, retain the
  // explicit CONTEXT_WINDOW_TOKENS fallback from the environment.
  try {
    const models = await listNvidiaModels();
    const currentModel = models.find((model) => model.id === config.nemotronModel);
    applyModelContext(currentModel ? await resolveNvidiaModelContext(currentModel) : undefined);
  } catch {
    // The model can still be used with the configured fallback window.
  }

  const deleteCurrentChat = async (): Promise<void> => {
    const current = chats.get(currentChatId);
    const main = chats.getMain(CLI_CHAT_SCOPE);
    if (!current || current.id === main.id) {
      appendTranscript(chalk.yellow("[ultron] the main conversation cannot be deleted.\n\n"));
      return;
    }
    chats.delete(current.id, CLI_CHAT_SCOPE);
    const next = chats.activateMain(CLI_CHAT_SCOPE);
    currentChatId = next.id;
    eventCursor = chatEvents.latestId(currentChatId);
    setActivePermissionLabel(chats.getSecurityMode(currentChatId));
    setTranscript("");
    printBanner(config.nemotronModel);
    appendTranscript(uiDim(`[ultron] deleted "${current.title}". Memory preserved. Returned to main.\n\n`));
  };

  const resumeChat = async (contextLine: string, commandArgument: string): Promise<void> => {
    let target: Chat | undefined;
    if (!commandArgument) {
      target = await pickArchivedChat(contextLine, { listArchived: () => chats.listResumable(CLI_CHAT_SCOPE), delete: (id) => chats.delete(id, CLI_CHAT_SCOPE) });
    } else {
      const query = commandArgument.toLowerCase();
      target = chats.listResumable(CLI_CHAT_SCOPE).find((chat) => chat.id === commandArgument || chat.title.toLowerCase().includes(query));
    }
    if (!target) {
      appendTranscript(chalk.yellow("[ultron] no archived chat selected.\n\n"));
      return;
    }
    chats.setFocus(target.id, CLI_CHAT_SCOPE);
    currentChatId = target.id;
    setActivePermissionLabel(chats.getSecurityMode(currentChatId));
    const messages = await listChatMessages(graph, currentChatId);
    // Set the cursor after the checkpoint has been read but before drawing
    // synchronously. This prevents an event arriving during the async
    // history load from being displayed and then wiped by showRestoredMessages.
    eventCursor = chatEvents.latestId(currentChatId);
    showRestoredMessages(messages, config.nemotronModel);
    appendTranscript(uiDim(`[ultron] resumed "${target.title}".\n\n`));
  };

  const switchToMain = async (): Promise<void> => {
    const main = chats.activateMain(CLI_CHAT_SCOPE);
    currentChatId = main.id;
    setActivePermissionLabel(chats.getSecurityMode(currentChatId));
    const messages = await listChatMessages(graph, currentChatId);
    eventCursor = chatEvents.latestId(currentChatId);
    showRestoredMessages(messages, config.nemotronModel);
    appendTranscript(uiDim(`[ultron] switched to main conversation.\n\n`));
  };

  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    appendTranscript(uiDim("\n[ultron] stopping...\n"));
    abortController?.abort();
    cancelActiveInput?.();
    clearInterval(eventPollTimer);
  });

  // One full turn: send turnInput, stream the reply, and loop through any
  // number of tool-approval interrupts until the model produces a final
  // answer (or the turn is aborted/errored). Factored out of the main loop
  // so /goal's driveGoalLoop (below) can replay this exact same path for
  // its own auto-continuation turns — a goal-loop turn is not a second,
  // simplified code path, it's the same turn a human-typed message gets,
  // approval prompts included.
  async function executeTurn(
    chatId: string,
    turnInput: { messages: HumanMessage[] } | Command,
    contextLine: string,
  ): Promise<{ finalText: string; aborted: boolean; errored: boolean }> {
    // A new turn means a new message followed whatever was last on screen —
    // collapse a tool block left dangling expanded at the end of the
    // previous turn.
    collapseDanglingToolBlock();
    abortController = new AbortController();
    const controller = abortController;
    const turnStarted = Date.now();
    setGenerationInput("", 0);
    const disarmStopCommand = armStopCommand(controller, contextLine);
    let finalText = "";

    try {
      let nextInput: { messages: HumanMessage[] } | Command = turnInput;

      let wrotePrefix = false;
      let inToolCall = false;
      let generatedChars = 0;
      let outputTokens: number | undefined;
      let inputTokens: number | undefined;
      const pendingToolCalls = new Map<string | number, { name: string; args: string }>();
      const markdown = new MarkdownStreamRenderer();

      // Loops more than once only when toolsNode's interrupt() (see
      // graph.ts) pauses the thread for approval — resumed below with a
      // Command carrying the user's decision, same as the web UI's
      // /api/approve round trip.
      for (;;) {
        // Serialized per chatId (see threadLock.ts), released again as soon
        // as this iteration's stream finishes — not held across the
        // human-approval prompt below, so a spawn_agent wake-up note
        // (tools/agents.ts) targeting this same chat isn't stuck behind the
        // user thinking about a y/n. Without this lock, that wake-up racing
        // a still-live stream on the same checkpoint thread was exactly
        // what let stray tool/report text bleed into an unrelated reply.
        await withThreadLock(chatId, async () => {
          const stream = await graph.stream(nextInput, {
            configurable: { thread_id: chatId, thinking: thinkingMode, taskMode },
            signal: controller.signal,
            streamMode: "messages",
            recursionLimit: config.graphRecursionLimit,
          });

          for await (const [chunk] of stream) {
            const type = chunk.getType();

            if (type === "tool") {
              if (inToolCall) {
                writeLive("\n", contextLine);
                inToolCall = false;
              }
              // A result belongs to the tool call that's now finishing, not
              // to whatever finished before it — collapse that older one now.
              collapseDanglingToolBlock();
              const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
              const blockStart = transcript.length;
              const pending = [...pendingToolCalls.values()].find((call) => call.name === toolName);
              if (pending) {
                writeLive(uiDim(`[${summarizeToolCall(pending.name, pending.args)}]\n`), contextLine);
                const key = [...pendingToolCalls.entries()].find(([, call]) => call === pending)?.[0];
                if (key !== undefined) pendingToolCalls.delete(key);
              }
              writeLive(`${formatToolResult(toolName, String(chunk.content))}\n\n`, contextLine);
              markDanglingToolBlock(blockStart, toolName);
              continue;
            }

            if (type !== "ai") continue;

            const toolCallChunks = (
              chunk as unknown as {
                tool_call_chunks?: { name?: string; args?: string; index?: number; id?: string }[];
              }
            ).tool_call_chunks;

            if (toolCallChunks?.length) {
              for (const tc of toolCallChunks) {
                const key = tc.index ?? tc.id ?? tc.name ?? 0;
                const isNewToolCall = !pendingToolCalls.has(key);
                const pending = pendingToolCalls.get(key) ?? { name: tc.name ?? "tool", args: "" };
                pending.name = tc.name ?? pending.name;
                pending.args += tc.args ?? "";
                pendingToolCalls.set(key, pending);
                if (tc.name && isNewToolCall) {
                  if (wrotePrefix) {
                    writeLive("\n\n", contextLine);
                    wrotePrefix = false;
                  }
                  // Another tool call is starting — the previous one is no
                  // longer the latest thing on screen.
                  collapseDanglingToolBlock();
                }
                if (tc.args) generatedChars += tc.args.length;
              }
              inToolCall = true;
              continue;
            }

            const usage = (chunk as unknown as { usage_metadata?: { input_tokens?: number; output_tokens?: number } })
              .usage_metadata;
            if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
            if (usage?.input_tokens !== undefined) inputTokens = usage.input_tokens;

            if (typeof chunk.content !== "string" || !chunk.content) continue;

            if (inToolCall) {
              writeLive("\n\n", contextLine);
              inToolCall = false;
            }
            if (!wrotePrefix) {
              // Real answer text is starting — the last tool call is no
              // longer the latest thing on screen.
              collapseDanglingToolBlock();
              writeLive(`${chalk.redBright.bold("ultron")} ${uiDim("›")} `, contextLine);
              wrotePrefix = true;
            }
            writeLive(markdown.push(chunk.content), contextLine);
            generatedChars += chunk.content.length;
            // Raw (unstyled) accumulation of the final answer text, kept
            // alongside the markdown-rendered transcript output above — this
            // is what /goal's judge reads, so it sees plain text rather than
            // ANSI-styled markdown fragments.
            finalText += chunk.content;
          }
        });

        const pendingApproval = await getPendingApproval(graph, chatId);
        if (!pendingApproval) break;
        if (inToolCall) {
          writeLive("\n", contextLine);
          inToolCall = false;
        }
        const decisions = await promptToolApproval(contextLine, pendingApproval.calls as unknown as PendingToolCall[]);
        nextInput = new Command({ resume: decisions as ToolApprovalDecision });
      }

      // Task bookkeeping is host-owned: close the whole plan once the
      // model has finished the actual turn, without sending one update call
      // per item back through the graph.
      todos.completeAll(chatId);
      writeLive(markdown.flush(), contextLine);
      appendTranscript("\n\n");

      const elapsedSeconds = (Date.now() - turnStarted) / 1000;
      // Nemotron's endpoint returns real usage on the stream's final chunk
      // (see nemotron.ts); fall back to the chars/4 estimate only if a
      // turn was interrupted before that chunk arrived.
      const generatedTokens = outputTokens ?? Math.max(1, Math.round(generatedChars / 4));
      if (verbose) {
        appendTranscript(
          uiDim(
            `  ${formatTurnStats({
              model: config.nemotronModel,
              inputTokens: inputTokens ?? 0,
              outputTokens: generatedTokens,
              elapsedSeconds,
            })}\n\n`,
          ),
        );
      }
      renderScreen("", 0, contextLine);
      // Passive memory extraction (see userModelExtractor.ts) — never
      // awaited, never blocks the next prompt from appearing; only runs for
      // an actual new user message, not an approval-decision Command resume.
      if ("messages" in turnInput) {
        const humanText = turnInput.messages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n")
          .trim();
        if (humanText && finalText.trim()) void recordUserModelObservation(chatId, humanText, finalText);
      }
      const exportedChat = chats.get(chatId);
      if (exportedChat) void maybeExportChat(graph, exportedChat);
      if (finalText.trim()) chatEvents.append(chatId, "ai", "cli", finalText.trim());
      return { finalText, aborted: false, errored: false };
    } catch (err) {
      if (controller.signal.aborted) {
        appendTranscript(uiDim("[ultron] generation stopped.\n\n"));
        renderScreen("", 0, contextLine);
        return { finalText, aborted: true, errored: false };
      }
      appendTranscript(chalk.red(`[ultron] error: ${err instanceof Error ? err.message : String(err)}\n\n`));
      return { finalText, aborted: false, errored: true };
    } finally {
      disarmStopCommand();
    }
  }

  // The /task goal auto-continuation loop: after a turn completes, ask a
  // separate, narrow-context judge (see goalJudge.ts) whether the goal is
  // actually done — reading the worker's final reply and the real state of
  // the code on disk, not the worker's own say-so. "continue" replays
  // executeTurn with a corrective message and checks again; "done" or
  // "blocked" stops the loop and hands control back to the prompt. Bounded
  // by config.goalMaxTurns so a goal that never resolves pauses itself
  // instead of running forever.
  async function driveGoalLoop(chatId: string, contextLine: string, initialFinalText: string): Promise<void> {
    let lastFinalText = initialFinalText;
    for (;;) {
      if (stopping) return;
      const goal = goals.get(chatId);
      if (!goal || goal.status !== "active") return;
      if (goal.turnsUsed >= goal.maxTurns) {
        goals.pause(chatId, `turn budget (${goal.maxTurns}) exhausted`);
        appendTranscript(
          chalk.yellow(
            `[ultron] goal paused — turn budget (${goal.maxTurns}) reached without a "done" verdict. Send another message to restart it, or /task none|todo|plan to leave goal mode.\n\n`,
          ),
        );
        renderScreen("", 0, contextLine);
        return;
      }

      appendTranscript(uiDim("[ultron] checking goal completion…\n"));
      renderScreen("", 0, contextLine);
      flushRender();

      // Reuses the same outer abortController slot as executeTurn so
      // Ctrl+C (the SIGINT handler above) can interrupt a judge call too,
      // not just a model turn.
      const judgeController = new AbortController();
      abortController = judgeController;
      let verdict: Awaited<ReturnType<typeof judgeGoal>>;
      try {
        verdict = await judgeGoal(
          { objective: goal.objective, finalMessage: lastFinalText, codeContext: gatherCodeContext(), healthContext: gatherHealthContext() },
          judgeController.signal,
        );
      } catch (err) {
        if (judgeController.signal.aborted) return;
        appendTranscript(
          chalk.red(`[ultron] goal check failed (${err instanceof Error ? err.message : String(err)}) — pausing rather than looping blind.\n\n`),
        );
        goals.pause(chatId, "goal check failed");
        renderScreen("", 0, contextLine);
        return;
      }
      if (judgeController.signal.aborted || stopping) return;

      if (verdict.verdict === "done") {
        goals.markDone(chatId, verdict.reason);
        appendTranscript(chalk.greenBright(`[ultron] ✓ goal achieved — ${verdict.reason}\n\n`));
        renderScreen("", 0, contextLine);
        return;
      }
      if (verdict.verdict === "blocked") {
        goals.pause(chatId, verdict.reason);
        appendTranscript(
          chalk.yellow(`[ultron] ⏸ goal blocked — ${verdict.reason}\n[ultron] send another message to retry, or /task none|todo|plan to leave goal mode.\n\n`),
        );
        renderScreen("", 0, contextLine);
        return;
      }

      goals.recordTurn(chatId);
      appendTranscript(
        uiDim(`[ultron] not done yet — ${verdict.reason}\n[ultron] continuing (turn ${goal.turnsUsed + 1}/${goal.maxTurns})…\n\n`),
      );
      renderScreen("", 0, contextLine);

      const turn = await executeTurn(
        chatId,
        { messages: [new HumanMessage(buildContinuationPrompt(goal.objective, verdict.reason))] },
        contextLine,
      );
      if (turn.aborted || turn.errored || stopping) return;
      lastFinalText = turn.finalText;
    }
  }

  try {
    while (!stopping) {
      const currentContextTokens = await estimateContextUsage(graph, currentChatId);
      const contextLine = renderContextBar(currentContextTokens, config.contextWindowTokens);
      let input = await readInput(contextLine);
      if (stopping) break;
      if (!input.trim()) continue;

      const rawInput = input.trim();
      const commandName = rawInput.split(/\s+/, 1)[0].toLowerCase();
      const command = rawInput.toLowerCase();
      const commandArgument = rawInput.slice(commandName.length).trim();
      if (command.startsWith("/")) {
        switch (command) {
          case "/help":
            printHelp();
            continue;
          case "/model":
            await changeModel(contextLine);
            continue;
          case "/status":
            printStatus(config.nemotronModel, tools.length, thinkingMode, taskMode, verbose, currentChatId, chats.getSecurityMode(currentChatId), goals.get(currentChatId));
            continue;
          case "/context": {
            const contextTokens = await estimateContextUsage(graph, currentChatId);
            appendTranscript(`${renderContextBar(contextTokens, config.contextWindowTokens)}\n\n`);
            continue;
          }
          case "/stop":
            appendTranscript(uiDim("[ultron] no active generation to stop.\n\n"));
            continue;
          case "/retry": {
            const retryInput = await prepareRetry(graph, currentChatId);
            if (!retryInput) {
              appendTranscript(chalk.yellow("[ultron] nothing to retry yet.\n\n"));
              continue;
            }
            input = retryInput;
            break;
          }
          case "/compact": {
            const result = await compactThread(graph, currentChatId);
            appendTranscript(
              result.compacted
                ? uiDim(`[ultron] compacted ${result.before} messages into ${result.after} context messages.\n\n`)
                : uiDim("[ultron] not enough history to compact yet.\n\n"),
            );
            continue;
          }
          case "/resume": {
            await resumeChat(contextLine, commandArgument);
            continue;
          }
          case "/main": {
            await switchToMain();
            continue;
          }
          case "/delete":
            await deleteCurrentChat();
            continue;
          case "/think":
            appendTranscript(uiDim(`[ultron] reasoning mode: ${thinkingMode} (use /think on|low|off).\n\n`));
            continue;
          case "/task":
            appendTranscript(uiDim(`[ultron] task mode: ${taskMode} (use /task none|todo|plan|goal).\n\n`));
            continue;
          case "/security":
            appendTranscript(
              uiDim(
                `[ultron] tool approval: ${chats.getSecurityMode(currentChatId)} (use /security bypass|accept_edit|manual).\n\n`,
              ),
            );
            continue;
          case "/permissions": {
            const selectedPermission = await pickPermission(contextLine, chats.getSecurityMode(currentChatId));
            if (!selectedPermission) {
              appendTranscript(uiDim("[ultron] permissions unchanged.\n\n"));
              continue;
            }
            chats.setSecurityMode(currentChatId, selectedPermission);
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
            if (commandName === "/resume") {
              await resumeChat(contextLine, commandArgument);
              continue;
            }
            if (command.startsWith("/think ")) {
              const mode = command.slice("/think ".length).trim();
              if (mode === "on" || mode === "full") thinkingMode = "full";
              else if (mode === "low") thinkingMode = "low";
              else if (mode === "off") thinkingMode = "off";
              else {
                appendTranscript(chalk.yellow("[ultron] use /think on, /think low or /think off.\n\n"));
                continue;
              }
              appendTranscript(uiDim(`[ultron] reasoning mode set to ${thinkingMode}.\n\n`));
              continue;
            }
            if (command.startsWith("/task ")) {
              const mode = command.slice("/task ".length).trim();
              if (mode !== "none" && mode !== "todo" && mode !== "plan" && mode !== "goal") {
                appendTranscript(chalk.yellow("[ultron] use /task none, /task todo, /task plan or /task goal.\n\n"));
                continue;
              }
              taskMode = mode;
              setActiveModeLabel(mode === "todo" ? "To-Do" : mode === "plan" ? "Plan" : mode === "goal" ? "Goal" : "None");
              // Task mode applies to the next user request. Drop any state
              // left by an earlier request now, before it can be mistaken
              // for the plan/goal of the new one — same reset-at-selection
              // rule for all three modes, not just todo/plan.
              if (mode === "todo" || mode === "plan") todos.clear(currentChatId);
              if (mode !== "goal") goals.clear(currentChatId);
              appendTranscript(uiDim(`[ultron] task mode set to ${taskMode}.\n\n`));
              continue;
            }
            if (command.startsWith("/security ")) {
              const mode = command.slice("/security ".length).trim();
              if (mode !== "bypass" && mode !== "accept_edit" && mode !== "manual") {
                appendTranscript(chalk.yellow("[ultron] use /security bypass, /security accept_edit or /security manual.\n\n"));
                continue;
              }
              chats.setSecurityMode(currentChatId, mode);
              setActivePermissionLabel(mode);
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
            if (command === "/verbose on" || command === "/verbose true") {
              verbose = true;
              appendTranscript(uiDim("[ultron] verbose on.\n\n"));
              continue;
            }
            if (command === "/verbose off" || command === "/verbose false") {
              verbose = false;
              appendTranscript(uiDim("[ultron] verbose off.\n\n"));
              continue;
            }
            if (commandName === "/export") {
              const currentChat = chats.get(currentChatId);
              if (!currentChat) {
                appendTranscript(chalk.yellow("[ultron] no active chat.\n\n"));
                continue;
              }
              const arg = commandArgument.trim();
              if (!arg) {
                appendTranscript(
                  uiDim(
                    currentChat.exportPath
                      ? `[ultron] live export: ${currentChat.exportPath} (updates after every turn) — /export off to stop.\n\n`
                      : "[ultron] no live export active for this chat — /export [path] to start, /export off to stop.\n\n",
                  ),
                );
                continue;
              }
              if (arg.toLowerCase() === "off") {
                chats.setExportPath(currentChatId, null);
                appendTranscript(uiDim("[ultron] live export stopped (file left as-is).\n\n"));
                continue;
              }
              const path = resolveExportPath(arg === "on" ? defaultExportPath(currentChat) : arg);
              chats.setExportPath(currentChatId, path);
              await maybeExportChat(graph, { ...currentChat, exportPath: path });
              appendTranscript(uiDim(`[ultron] live export started: ${path} (updates after every turn).\n\n`));
              continue;
            }
            if (commandName === "/memory") {
              const arg = commandArgument.toLowerCase();
              const registry = getUserModelRegistry(config.databasePath);
              if (!arg) {
                const observations = registry.list(30);
                if (!observations.length) {
                  appendTranscript(uiDim("[ultron] no observations accumulated yet.\n\n"));
                  continue;
                }
                const lines = observations
                  .map((o) => `  ${uiDim(`#${o.id}`)} ${chalk.cyanBright(`(${o.category})`)} ${o.content}`)
                  .join("\n");
                appendTranscript(
                  `${uiDim(`[ultron] ${registry.count()} observation(s) accumulated automatically — /memory clear or /memory forget <id>`)}\n${lines}\n\n`,
                );
                continue;
              }
              if (arg === "clear") {
                registry.clear();
                appendTranscript(uiDim("[ultron] all accumulated observations cleared.\n\n"));
                continue;
              }
              if (command.startsWith("/memory forget ")) {
                const id = Number(command.slice("/memory forget ".length).trim());
                if (!Number.isInteger(id)) {
                  appendTranscript(chalk.yellow("[ultron] use /memory forget <id> (see /memory for ids).\n\n"));
                  continue;
                }
                registry.remove(id);
                appendTranscript(uiDim(`[ultron] observation #${id} forgotten (if it existed).\n\n`));
                continue;
              }
              appendTranscript(chalk.yellow("[ultron] use /memory, /memory clear or /memory forget <id>.\n\n"));
              continue;
            }
            if (commandName === "/health") {
              const health = getHealthRegistry(config.databasePath);
              const to = new Date().toISOString().slice(0, 10);
              const from = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
              const days = health.getRange(from, to);
              if (!days.length) {
                appendTranscript(uiDim("[ultron] no health data ingested yet.\n\n"));
                continue;
              }
              const steps = sparkline(days.map((d) => d.steps));
              const lines = days
                .map((day) => {
                  const parts: string[] = [];
                  if (day.steps !== null) parts.push(`${day.steps} steps`);
                  if (day.sleepDurationSec !== null) parts.push(`${(day.sleepDurationSec / 3600).toFixed(1)}h sleep`);
                  if (day.restingHR !== null) parts.push(`resting HR ${day.restingHR}`);
                  if (day.hrvAvg !== null) parts.push(`HRV ${day.hrvAvg}ms`);
                  return `  ${uiDim(day.date)} ${parts.length ? parts.join(", ") : uiDim("no data")}`;
                })
                .join("\n");
              const latest = pickLatestWithData(days)!;
              const getBaseline30 = (m: HealthMetric) => health.getBaseline(m, 30);
              const recovery = computeRecoveryScore(latest, getBaseline30);
              const activity = computeActivityScore(latest, getBaseline30);
              const anomalies = detectAnomalies(latest, getBaseline30);
              const records = health.getRecords();
              const scoreLine = `${uiDim("recovery")} ${recovery}/100  ${uiDim("activity")} ${activity}/100  ${uiDim("streak")} ${records.currentActivityStreakDays}d`;
              const anomalyLine = anomalies.length ? chalk.yellow(`  ⚠ ${anomalies[0].message}`) : "";
              appendTranscript(`${uiDim(`[ultron] last 7 days — steps ${steps}`)}\n${lines}\n${scoreLine}\n${anomalyLine ? `${anomalyLine}\n` : ""}\n`);
              continue;
            }
            appendTranscript(chalk.yellow(`[ultron] unknown command: ${input.trim()} — try /help\n\n`));
            continue;
        }
      }

      if (command !== "/retry") chats.maybeAutoTitle(currentChatId, input);
      chats.setFocus(currentChatId, CLI_CHAT_SCOPE);
      chats.touch(currentChatId);

      // The selector describes the current request, not the whole chat.
      // Reset persisted task state at this boundary so an interrupted or
      // completed request cannot make the next one resume an old plan.
      if (command !== "/retry" && (taskMode === "todo" || taskMode === "plan")) todos.clear(currentChatId);
      // "goal" mode works the same way as todo/plan: selecting it just
      // arms the mode (see the /task handler above), and the next message
      // sent while it's active becomes the objective — no separate
      // "/task goal <objective>" syntax. Every non-retry message while in
      // goal mode starts a fresh goal (goals.set() overwrites any previous
      // one for this chat), mirroring todo/plan's per-message reset.
      if (command !== "/retry" && taskMode === "goal") {
        goals.set(currentChatId, input, config.goalMaxTurns);
        appendTranscript(uiDim(`[ultron] goal: ${input} (self-checking after each turn, max ${config.goalMaxTurns})\n\n`));
      }

      // expandSkillMentions only touches what's sent to the model — the
      // transcript and title/goal-objective logic above already used the
      // raw, unexpanded input, which is what should stay on screen.
      const turnInput: { messages: HumanMessage[] } | Command = {
        messages: command === "/retry" ? [] : [new HumanMessage(expandSkillMentions(input))],
      };
      if (command !== "/retry") chatEvents.append(currentChatId, "human", "cli", input);
      const result = await executeTurn(currentChatId, turnInput, contextLine);
      // A goal stays "active" in the DB across an aborted/interrupted turn
      // (see driveGoalLoop's early returns) — checked fresh here rather than
      // trusting a stale in-memory flag.
      if (!result.aborted && !result.errored && goals.get(currentChatId)?.status === "active") {
        await driveGoalLoop(currentChatId, contextLine, result.finalText);
      }
    }
  } finally {
    cancelActiveInput?.();
    clearInterval(eventPollTimer);
    appendTranscript(uiDim("[ultron] stopped.\n"));
    stdout.write(uiDim("[ultron] stopped.\n"));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red("[ultron] fatal error:"), err);
  process.exit(1);
});
