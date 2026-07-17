import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import {
  archiveThread,
  buildGraph,
  compactThread,
  estimateContextUsage,
  getPendingApproval,
  listChatMessages,
  prepareRetry,
  resumeThread,
  type PendingToolCall,
  type TaskMode,
  type ToolApprovalDecision,
} from "../../core/graph.js";
import { withThreadLock } from "../../core/threadLock.js";
import { config } from "../../config.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { DEFAULT_CHAT_TITLE, getChatRegistry, LEGACY_CHAT_ID, type SecurityMode } from "../../core/memory/chats.js";
import { getGoalRegistry, type Goal } from "../../core/memory/goals.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { buildContinuationPrompt, gatherCodeContext, judgeGoal } from "../../core/goalJudge.js";
import { disableConsoleEcho } from "../../core/logger.js";
import { tools } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
import { MarkdownStreamRenderer } from "./markdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_BAR_WIDTH = 20;
const INPUT_PROMPT = `${chalk.cyanBright.bold("you")} ${chalk.dim("›")} `;
const LOCAL_COMMANDS = ["/help", "/status", "/clear", "/context", "/stop", "/retry", "/compact", "/archive", "/resume", "/think", "/task", "/security", "/goal", "/verbose", "/quit"];

let cancelActiveInput: (() => void) | undefined;
let transcript = "";
let generationInput = "";
let generationCursor = 0;
let pendingRender: { input: string; cursor: number; contextLine: string } | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let activePrompt = INPUT_PROMPT;

function appendTranscript(text: string): void {
  transcript += text;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function transcriptRows(text: string): number {
  const width = Math.max(1, stdout.columns || 80);
  return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(stripAnsi(line).length / width)), 0);
}

function wrappedRows(text: string): number {
  const width = Math.max(1, stdout.columns || 80);
  return Math.max(1, Math.ceil(stripAnsi(text).length / width));
}

function commandSuggestion(input: string): string {
  if (!input.startsWith("/") || /\s/.test(input)) return "";
  return LOCAL_COMMANDS.find((command) => command.startsWith(input) && command !== input) ?? "";
}

function drawScreen(input: string, cursor: number, contextLine: string): void {
  const content = transcript.endsWith("\n") ? transcript : `${transcript}\n`;
  const suggestion = commandSuggestion(input);
  const suggestionLine = suggestion ? chalk.dim(`↳ ${suggestion}`) : "";
  const footer = `${rule()}\n${activePrompt}${input}\n${suggestionLine}\n${contextLine}\n${rule()}`;
  const footerRows = footer.split("\n").reduce((rows, line) => rows + wrappedRows(line), 0);
  const rows = stdout.rows || 24;
  const padding = Math.max(0, rows - transcriptRows(content) - footerRows);

  stdout.write(`\x1b[2J\x1b[H${content}${"\n".repeat(padding)}${footer}`);
  // Position absolutely inside the freshly drawn frame. Relative cursor
  // moves from the final rule are terminal-dependent once the transcript or
  // footer wraps, which was placing the visible cursor one line above the
  // input even though keystrokes still went to the right value.
  const promptWidth = stripAnsi(activePrompt).length + cursor;
  const width = Math.max(1, stdout.columns || 80);
  const promptRow = transcriptRows(content) + padding;
  readline.cursorTo(stdout, promptWidth % width, promptRow + Math.floor(promptWidth / width));
}

function renderScreen(input: string, cursor: number, contextLine: string): void {
  pendingRender = { input, cursor, contextLine };
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    const next = pendingRender;
    pendingRender = undefined;
    if (next) drawScreen(next.input, next.cursor, next.contextLine);
  }, 24);
}

function flushRender(): void {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = undefined;
  }
  const next = pendingRender;
  pendingRender = undefined;
  if (next) drawScreen(next.input, next.cursor, next.contextLine);
}

function writeLive(text: string, contextLine: string): void {
  if (!text) return;
  appendTranscript(text);
  renderScreen(generationInput, generationCursor, contextLine);
}

function ruleWidth(): number {
  // Leave one column empty. A rule that exactly fills the terminal can
  // trigger the terminal's automatic wrap, adding an invisible line; the
  // cursor calculation below would then land on the line above the input.
  return Math.min(Math.max(1, (stdout.columns || 80) - 1), 76);
}

function rule(): string {
  return chalk.dim("─".repeat(ruleWidth()));
}

function readInput(
  contextLine: string,
  initialValue = "",
  prompt = INPUT_PROMPT,
  recordHistory = true,
): Promise<string> {
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  activePrompt = prompt;

  return new Promise((resolve) => {
    let value = initialValue;
    let cursor = value.length;
    let finished = false;

    const finish = (result: string, keepHistory = true) => {
      if (finished) return;
      finished = true;
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      cancelActiveInput = undefined;

      if (keepHistory && recordHistory && result.trim()) appendTranscript(`${activePrompt}${result}\n`);
      renderScreen("", 0, contextLine);
      flushRender();
      activePrompt = INPUT_PROMPT;
      resolve(result);
    };

    const onKeypress = (input: string, key: readline.Key) => {
      if (key.name === "return" || key.name === "enter") {
        finish(value);
        return;
      }
      if (key.ctrl && key.name === "d") {
        process.emit("SIGINT");
        return;
      }
      if (key.name === "tab") {
        const suggestion = commandSuggestion(value);
        if (suggestion) {
          value = suggestion;
          cursor = value.length;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "backspace") {
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor--;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "delete") {
        if (cursor < value.length) {
          value = value.slice(0, cursor) + value.slice(cursor + 1);
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "left") {
        if (cursor > 0) {
          cursor--;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "right") {
        if (cursor < value.length) {
          cursor++;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "home") {
        cursor = 0;
        renderScreen(value, cursor, contextLine);
        return;
      }
      if (key.name === "end") {
        cursor = value.length;
        renderScreen(value, cursor, contextLine);
        return;
      }
      if (!key.ctrl && !key.meta && input && !input.includes("\n") && !input.includes("\r")) {
        value = value.slice(0, cursor) + input + value.slice(cursor);
        cursor += input.length;
        renderScreen(value, cursor, contextLine);
      }
    };

    cancelActiveInput = () => finish("", false);
    stdin.on("keypress", onKeypress);
    renderScreen(value, cursor, contextLine);
  });
}

interface ArchiveEntry {
  path: string;
  title: string;
}

function listArchives(): ArchiveEntry[] {
  const archiveDir = join(process.cwd(), "archives");
  try {
    return readdirSync(archiveDir)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => {
        const path = join(archiveDir, name);
        const content = readFileSync(path, "utf-8");
        const title = content.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || name.replace(/\.txt$/, "");
        return { path, title };
      })
      .sort((a, b) => b.path.localeCompare(a.path));
  } catch {
    return [];
  }
}

function pickArchive(contextLine: string): Promise<string | undefined> {
  const archives = listArchives();
  if (archives.length === 0) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let query = "";
    let selected = 0;
    let finished = false;

    const redraw = () => {
      const matches = archives.filter((archive) => archive.title.toLowerCase().includes(query.toLowerCase()));
      selected = Math.min(selected, Math.max(0, matches.length - 1));
      const rows = matches.length
        ? matches
            .map((archive, index) => {
              const marker = index === selected ? chalk.greenBright("›") : " ";
              return `  ${marker} ${archive.title}`;
            })
            .join("\n")
        : chalk.dim("  no matching chats");
      const prompt = `${chalk.magentaBright.bold("resume")} ${chalk.dim("›")} `;
      const content = transcript.endsWith("\n") ? transcript : `${transcript}\n`;
      const picker = `${chalk.dim("Select a chat · type to search · ↑/↓ navigate · Enter confirm")}\n${rows}`;
      const footer = `${rule()}\n${prompt}${query}\n${contextLine}\n${rule()}`;
      const padding = Math.max(0, (stdout.rows || 24) - transcriptRows(content + `${picker}\n`) - 4);
      stdout.write(`\x1b[2J\x1b[H${content}${picker}\n${"\n".repeat(padding)}${footer}`);
      readline.moveCursor(stdout, 0, -2);
      readline.cursorTo(stdout, prompt.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length + query.length);
    };

    const finish = (path?: string) => {
      if (finished) return;
      finished = true;
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      cancelActiveInput = undefined;
      renderScreen("", 0, contextLine);
      flushRender();
      resolve(path);
    };

    const onKeypress = (input: string, key: readline.Key) => {
      const matches = archives.filter((archive) => archive.title.toLowerCase().includes(query.toLowerCase()));
      if (key.name === "return" || key.name === "enter") {
        finish(matches[selected]?.path);
        return;
      }
      if (key.name === "escape") {
        finish();
        return;
      }
      if (key.name === "up") {
        if (matches.length) selected = (selected - 1 + matches.length) % matches.length;
        redraw();
        return;
      }
      if (key.name === "down") {
        if (matches.length) selected = (selected + 1) % matches.length;
        redraw();
        return;
      }
      if (key.name === "backspace") {
        query = query.slice(0, -1);
        selected = 0;
        redraw();
        return;
      }
      if (!key.ctrl && !key.meta && input && !input.includes("\n") && !input.includes("\r")) {
        query += input;
        selected = 0;
        redraw();
      }
    };

    cancelActiveInput = () => finish();
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.on("keypress", onKeypress);
    redraw();
  });
}

async function showRestoredMessages(graph: ReturnType<typeof buildGraph>, threadId: string): Promise<void> {
  const messages = await listChatMessages(graph, threadId);
  transcript = "";
  printBanner();
  for (const message of messages) {
    if (message.role === "human") {
      appendTranscript(`${INPUT_PROMPT}${message.content}\n`);
    } else if (message.role === "ai") {
      appendTranscript(`${chalk.redBright.bold("ultron")} ${chalk.dim("›")} ${message.content}\n\n`);
    } else if (message.role === "tool_call") {
      appendTranscript(chalk.dim(`[${message.content}]\n`));
    } else {
      appendTranscript(`${formatToolResult(message.name ?? "tool", message.content)}\n\n`);
    }
  }
}

const SECURITY_LABELS: Record<SecurityMode, string> = {
  bypass: "bypass (run everything)",
  accept_edit: "accept edit (confirm destructive calls)",
  manual: "manual (confirm every call)",
};

// Backs the pause created by toolsNode's interrupt() (see graph.ts) — a
// single yes/no for the whole batch, since the terminal has no per-call
// widget the way the web UI's approval block does.
//
// A lone plan_propose call (Plan task mode, see plan.ts) gets a distinct
// rendering — a numbered plan instead of a raw args blob, and a
// start/discuss framing instead of generic approve/deny — mirroring the
// web UI's addApprovalBlock (thread.js). Same interrupt/resume plumbing
// underneath either way.
async function promptToolApproval(contextLine: string, calls: PendingToolCall[]): Promise<ToolApprovalDecision> {
  const isPlan = calls.length === 1 && calls[0].name === "plan_propose";

  if (isPlan) {
    const items = (calls[0].args as { items?: { content?: string }[] } | undefined)?.items ?? [];
    const list = items.map((item, i) => `  ${chalk.dim(`${i + 1}.`)} ${item.content ?? String(item)}`).join("\n");
    appendTranscript(`${chalk.yellowBright.bold(`[ultron] plan proposed · ${items.length} step${items.length === 1 ? "" : "s"}`)}\n${list}\n`);
    renderScreen("", 0, contextLine);
    flushRender();

    const answer = (
      await readInput(contextLine, "", `${chalk.yellowBright.bold("start?")} ${chalk.dim("(y/n) ›")} `, false)
    )
      .trim()
      .toLowerCase();
    const approved = answer === "y" || answer === "yes";
    appendTranscript(
      chalk.dim(approved ? "[ultron] plan started.\n\n" : "[ultron] plan not approved — discuss changes, then it can be re-proposed.\n\n"),
    );
    return { [calls[0].id]: approved };
  }

  const list = calls
    .map((c) => `  ${chalk.yellow("•")} ${chalk.bold(c.name)} ${chalk.dim(JSON.stringify(c.args))}`)
    .join("\n");
  appendTranscript(`${chalk.yellowBright.bold("[ultron] approval required")}\n${list}\n`);
  renderScreen("", 0, contextLine);
  flushRender();

  const answer = (
    await readInput(contextLine, "", `${chalk.yellowBright.bold("approve?")} ${chalk.dim("(y/n) ›")} `, false)
  )
    .trim()
    .toLowerCase();
  const approved = answer === "y" || answer === "yes";
  appendTranscript(chalk.dim(`[ultron] ${approved ? "approved" : "denied"} ${calls.length} tool call(s).\n\n`));

  const decisions: ToolApprovalDecision = {};
  for (const call of calls) decisions[call.id] = approved;
  return decisions;
}

// Tool-result rendering, shared by the live stream loop and history replay
// (showRestoredMessages) so a chat looks the same whether you're watching
// it happen or reopening it later. Previously every tool dumped its full,
// unstyled content under the same "[tool result · name]" dim-gray header —
// readable for a short shell/file result, but a long web_search or
// fetch_url blob just flooded the transcript with no visual structure.
const RESULT_MAX_CHARS = 1400;
const RESULT_MAX_LINES = 16;

// Caps length/line count so one huge result can't push everything above it
// off-screen — the full untruncated text is still what the model sees (this
// only affects what gets printed to the terminal).
function capForDisplay(text: string): string {
  let out = text.length > RESULT_MAX_CHARS ? text.slice(0, RESULT_MAX_CHARS) : text;
  const lines = out.split("\n");
  if (lines.length > RESULT_MAX_LINES) out = lines.slice(0, RESULT_MAX_LINES).join("\n");
  if (out.length === text.length) return out;
  const omitted = text.length - out.length;
  return `${out}\n${chalk.dim(`… (${omitted.toLocaleString()} more characters not shown — full result is still in context)`)}`;
}

// Numbered-result blocks from formatSearchResults (search.ts): "source: X",
// then "N. Title" / "   https://…" / "   metadata" / "   snippet" groups.
function styleSearchResults(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (/^source: /.test(line)) return chalk.dim(line);
      if (/^\d+\.\s/.test(line)) return chalk.bold.whiteBright(line);
      const urlMatch = line.match(/^(\s*)(https?:\/\/\S+)$/);
      if (urlMatch) return `${urlMatch[1]}${chalk.cyan.underline(urlMatch[2])}`;
      return chalk.dim(line);
    })
    .join("\n");
}

// fetch_url/http_request's "status: …\nurl: …\n\n<body>" header.
function styleFetchResult(content: string): string {
  const [head, ...rest] = content.split("\n\n");
  const styledHead = head
    .split("\n")
    .map((line) => chalk.dim(line))
    .join("\n");
  const body = rest.join("\n\n");
  return body ? `${styledHead}\n\n${capForDisplay(body)}` : styledHead;
}

function formatToolResult(name: string, content: string): string {
  if (name === "web_search") return `${chalk.cyanBright.bold("[search]")}\n${styleSearchResults(capForDisplay(content))}`;
  if (name === "fetch_url" || name === "http_request") return `${chalk.blueBright.bold("[fetch]")}\n${styleFetchResult(content)}`;
  if (name === "spawn_agent") return `${chalk.magentaBright.bold("[agent]")} ${content}`;
  return `${chalk.dim(`[tool result · ${name}]`)}\n${capForDisplay(content)}`;
}

function contextBarColor(ratio: number): (text: string) => string {
  if (ratio < 0.5) return chalk.greenBright;
  if (ratio < 0.8) return chalk.yellowBright;
  return chalk.redBright;
}

function renderContextBar(usedTokens: number, maxTokens: number): string {
  const ratio = Math.min(usedTokens / maxTokens, 1);
  const filled = Math.round(ratio * CONTEXT_BAR_WIDTH);
  const fillColor = contextBarColor(ratio);
  const bar = fillColor("█".repeat(filled)) + chalk.dim("░".repeat(CONTEXT_BAR_WIDTH - filled));
  const pct = Math.round(ratio * 100);
  const maxLabel =
    maxTokens >= 1_000_000
      ? `${maxTokens / 1_000_000}M`
      : maxTokens >= 1000
        ? `${Math.round(maxTokens / 1000)}k`
        : String(maxTokens);
  return `${chalk.dim("context")}  ${bar}  ${usedTokens.toLocaleString()} / ${maxLabel} tokens (${fillColor(`${pct}%`)})`;
}

function printBanner() {
  const art = readFileSync(join(__dirname, "ascii-art.txt"), "utf-8").trimEnd();
  appendTranscript(
    `${art}\n\n  ${chalk.dim("model")}    ${config.nemotronModel}\n  ${chalk.dim("memory")}   MEMORY.md\n  ${chalk.dim("status")}   ${chalk.greenBright("ready")}\n\n${chalk.dim("  type a message to begin · ctrl+c to stop at any time")}\n\n`,
  );
  stdout.write(transcript);
}

function printHelp() {
  appendTranscript(
    `${chalk.dim("  local commands")}\n  ${chalk.cyanBright("/help")}     show this help\n  ${chalk.cyanBright("/status")}   show model, memory and tool status\n  ${chalk.cyanBright("/clear")}    clear the terminal and redraw the banner\n  ${chalk.cyanBright("/context")}  show context usage\n  ${chalk.cyanBright("/stop")}     stop the active generation\n  ${chalk.cyanBright("/retry")}    retry the last user message\n  ${chalk.cyanBright("/compact")}  summarize and compact session history\n  ${chalk.cyanBright("/archive")}  edit the title, then archive the chat\n  ${chalk.cyanBright("/resume")}   search and select an archived chat\n  ${chalk.cyanBright("/think")}    set reasoning: on, low or off\n  ${chalk.cyanBright("/task")}     set task mode: none, todo or plan\n  ${chalk.cyanBright("/security")} set tool approval: bypass, accept_edit or manual\n  ${chalk.cyanBright("/goal")}     set/inspect a standing goal: /goal <objective>, /goal status, /goal pause, /goal resume, /goal clear\n  ${chalk.cyanBright("/verbose")}  toggle timing and token metrics\n  ${chalk.cyanBright("/quit")}     stop ULTRON\n\n`,
  );
}

// Shared by /status and /goal (bare or "status") — same one-liner either
// way so the two surfaces never drift into describing the goal differently.
function goalStatusLine(goal: Goal | undefined): string {
  if (!goal || goal.status === "cleared") return "no active goal — set one with /goal <objective>";
  const turns = `${goal.turnsUsed}/${goal.maxTurns} turns`;
  if (goal.status === "active") return `active (${turns}): ${goal.objective}`;
  if (goal.status === "paused") return `paused${goal.lastReason ? ` — ${goal.lastReason}` : ""} (${turns}): ${goal.objective}`;
  if (goal.status === "complete") return `✓ complete${goal.lastReason ? ` — ${goal.lastReason}` : ""}: ${goal.objective}`;
  return `${goal.status}: ${goal.objective}`;
}

function printStatus(
  thinkingMode: ThinkingMode,
  taskMode: TaskMode,
  verbose: boolean,
  chatId: string,
  securityMode: SecurityMode,
  goal: Goal | undefined,
) {
  appendTranscript(
    `  ${chalk.dim("model")}    ${config.nemotronModel}\n  ${chalk.dim("memory")}   MEMORY.md · chat ${chatId}\n  ${chalk.dim("tools")}    ${tools.length} available\n  ${chalk.dim("think")}    ${thinkingMode}\n  ${chalk.dim("task")}     ${taskMode}\n  ${chalk.dim("security")} ${securityMode}\n  ${chalk.dim("goal")}     ${goalStatusLine(goal)}\n  ${chalk.dim("verbose")}  ${verbose ? "on" : "off"}\n  ${chalk.dim("status")}   ${chalk.greenBright("ready")}\n\n`,
  );
}

function armStopCommand(abort: AbortController, contextLine: string): () => void {
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  const onKeypress = (input: string, key: readline.Key) => {
    if (key.ctrl && key.name === "c") {
      process.emit("SIGINT");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (generationInput.trim().toLowerCase() === "/stop") abort.abort();
      else if (generationInput.trim()) appendTranscript(chalk.yellow("[ultron] only /stop is available while generating.\n"));
      generationInput = "";
      generationCursor = 0;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "backspace") {
      if (generationCursor > 0) {
        generationInput = generationInput.slice(0, generationCursor - 1) + generationInput.slice(generationCursor);
        generationCursor--;
        renderScreen(generationInput, generationCursor, contextLine);
      }
      return;
    }
    if (key.name === "left") {
      if (generationCursor > 0) generationCursor--;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "right") {
      if (generationCursor < generationInput.length) generationCursor++;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "home") {
      generationCursor = 0;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "end") {
      generationCursor = generationInput.length;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (!key.ctrl && !key.meta && input && !input.includes("\n") && !input.includes("\r")) {
      generationInput = generationInput.slice(0, generationCursor) + input + generationInput.slice(generationCursor);
      generationCursor += input.length;
      renderScreen(generationInput, generationCursor, contextLine);
    }
  };
  stdin.on("keypress", onKeypress);
  return () => {
    stdin.removeListener("keypress", onKeypress);
    stdin.setRawMode?.(false);
  };
}

async function main() {
  // Must happen before anything else can log — the CLI owns raw-mode
  // terminal drawing from here on (see drawScreen), and a stray
  // console.error from graph.ts/tools would otherwise land as garbage text
  // spliced into the middle of that live-rendered UI.
  disableConsoleEcho();
  printBanner();

  const graph = buildGraph();
  const chats = getChatRegistry(config.databasePath);
  const goals = getGoalRegistry(config.databasePath);
  const todos = getTodoRegistry(config.databasePath);
  // Registers the CLI's original hardcoded thread (from before chats
  // existed) so its history shows up in the registry instead of being
  // orphaned — same migration the web server runs on its own startup.
  chats.ensure(LEGACY_CHAT_ID);
  // Resume whichever chat was most recently active, from either interface —
  // not always the legacy thread, since /archive or the web UI may have
  // moved on to a newer one since the CLI last ran.
  let currentChatId = chats.list()[0].id;

  let abortController: AbortController | undefined;
  let stopping = false;
  let thinkingMode: ThinkingMode = "full";
  let taskMode: TaskMode = "none";
  let verbose = false;

  const archiveCurrentChat = async (contextLine: string, requestedTitle?: string): Promise<void> => {
    let title = requestedTitle?.trim();
    if (!title) {
      const chat = chats.get(currentChatId);
      const suggestedTitle = chat && chat.title !== DEFAULT_CHAT_TITLE ? chat.title : "";
      title = (
        await readInput(
          contextLine,
          suggestedTitle,
          `${chalk.magentaBright.bold("title")} ${chalk.dim("›")} `,
          false,
        )
      ).trim();
    }

    if (title) chats.rename(currentChatId, title);
    const archive = await archiveThread(graph, currentChatId, title || undefined);
    const nextChat = chats.create();
    currentChatId = nextChat.id;
    appendTranscript(`${chalk.greenBright(`Chat Archived "${archive.title}"`)}\n\n`);
  };

  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    appendTranscript(chalk.dim("\n[ultron] stopping...\n"));
    abortController?.abort();
    cancelActiveInput?.();
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
    abortController = new AbortController();
    const controller = abortController;
    const turnStarted = Date.now();
    generationInput = "";
    generationCursor = 0;
    const disarmStopCommand = armStopCommand(controller, contextLine);
    let finalText = "";

    try {
      let nextInput: { messages: HumanMessage[] } | Command = turnInput;

      let wrotePrefix = false;
      let inToolCall = false;
      let generatedChars = 0;
      let outputTokens: number | undefined;
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
              const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
              const pending = [...pendingToolCalls.values()].find((call) => call.name === toolName);
              if (pending) {
                writeLive(chalk.dim(`[${summarizeToolCall(pending.name, pending.args)}]\n`), contextLine);
                const key = [...pendingToolCalls.entries()].find(([, call]) => call === pending)?.[0];
                if (key !== undefined) pendingToolCalls.delete(key);
              }
              writeLive(`${formatToolResult(toolName, String(chunk.content))}\n\n`, contextLine);
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
                }
                if (tc.args) generatedChars += tc.args.length;
              }
              inToolCall = true;
              continue;
            }

            const usage = (chunk as unknown as { usage_metadata?: { output_tokens?: number } }).usage_metadata;
            if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;

            if (typeof chunk.content !== "string" || !chunk.content) continue;

            if (inToolCall) {
              writeLive("\n\n", contextLine);
              inToolCall = false;
            }
            if (!wrotePrefix) {
              writeLive(`${chalk.redBright.bold("ultron")} ${chalk.dim("›")} `, contextLine);
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
        const decisions = await promptToolApproval(contextLine, pendingApproval.calls);
        nextInput = new Command({ resume: decisions });
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
      const tokenLabel = outputTokens !== undefined ? `${generatedTokens.toLocaleString()} tokens` : `≈${generatedTokens.toLocaleString()} tokens`;
      if (verbose) appendTranscript(chalk.dim(`  ⏱ ${elapsedSeconds.toFixed(1)}s   ${tokenLabel}\n\n`));
      renderScreen("", 0, contextLine);
      return { finalText, aborted: false, errored: false };
    } catch (err) {
      if (controller.signal.aborted) {
        appendTranscript(chalk.dim("[ultron] generation stopped.\n\n"));
        renderScreen("", 0, contextLine);
        return { finalText, aborted: true, errored: false };
      }
      appendTranscript(chalk.red(`[ultron] error: ${err instanceof Error ? err.message : String(err)}\n\n`));
      return { finalText, aborted: false, errored: true };
    } finally {
      disarmStopCommand();
    }
  }

  // The /goal auto-continuation loop: after a turn completes, ask a
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
            `[ultron] goal paused — turn budget (${goal.maxTurns}) reached without a "done" verdict. /goal resume to give it more room, or /goal clear to drop it.\n\n`,
          ),
        );
        renderScreen("", 0, contextLine);
        return;
      }

      appendTranscript(chalk.dim("[ultron] checking goal completion…\n"));
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
          { objective: goal.objective, finalMessage: lastFinalText, codeContext: gatherCodeContext() },
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
          chalk.yellow(`[ultron] ⏸ goal blocked — ${verdict.reason}\n[ultron] resume with /goal resume once that's addressed.\n\n`),
        );
        renderScreen("", 0, contextLine);
        return;
      }

      goals.recordTurn(chatId);
      appendTranscript(
        chalk.dim(`[ultron] not done yet — ${verdict.reason}\n[ultron] continuing (turn ${goal.turnsUsed + 1}/${goal.maxTurns})…\n\n`),
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
          case "/status":
            printStatus(thinkingMode, taskMode, verbose, currentChatId, chats.getSecurityMode(currentChatId), goals.get(currentChatId));
            continue;
          case "/clear":
            transcript = "";
            printBanner();
            continue;
          case "/context": {
            const contextTokens = await estimateContextUsage(graph, currentChatId);
            appendTranscript(`${renderContextBar(contextTokens, config.contextWindowTokens)}\n\n`);
            continue;
          }
          case "/stop":
            appendTranscript(chalk.dim("[ultron] no active generation to stop.\n\n"));
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
                ? chalk.dim(`[ultron] compacted ${result.before} messages into ${result.after} context messages.\n\n`)
                : chalk.dim("[ultron] not enough history to compact yet.\n\n"),
            );
            continue;
          }
          case "/archive": {
            await archiveCurrentChat(contextLine, commandArgument);
            continue;
          }
          case "/resume":
            if (!commandArgument) {
              const selectedArchive = await pickArchive(contextLine);
              if (!selectedArchive) {
                appendTranscript(chalk.yellow("[ultron] no archive selected.\n\n"));
                continue;
              }
              try {
                const messageCount = await resumeThread(graph, currentChatId, selectedArchive);
                await showRestoredMessages(graph, currentChatId);
                appendTranscript(chalk.dim(`[ultron] resumed ${messageCount} messages.\n\n`));
              } catch (error) {
                appendTranscript(chalk.red(`[ultron] could not resume archive: ${error instanceof Error ? error.message : String(error)}\n\n`));
              }
              continue;
            }
            try {
              const messageCount = await resumeThread(graph, currentChatId, commandArgument);
              await showRestoredMessages(graph, currentChatId);
              appendTranscript(chalk.dim(`[ultron] resumed ${messageCount} messages from ${commandArgument}\n\n`));
            } catch (error) {
              appendTranscript(chalk.red(`[ultron] could not resume archive: ${error instanceof Error ? error.message : String(error)}\n\n`));
            }
            continue;
          case "/think":
            appendTranscript(chalk.dim(`[ultron] reasoning mode: ${thinkingMode} (use /think on|low|off).\n\n`));
            continue;
          case "/task":
            appendTranscript(chalk.dim(`[ultron] task mode: ${taskMode} (use /task none|todo|plan).\n\n`));
            continue;
          case "/security":
            appendTranscript(
              chalk.dim(
                `[ultron] tool approval: ${chats.getSecurityMode(currentChatId)} (use /security bypass|accept_edit|manual).\n\n`,
              ),
            );
            continue;
          case "/verbose":
            appendTranscript(chalk.dim(`[ultron] verbose is ${verbose ? "on" : "off"} (use /verbose on|off).\n\n`));
            continue;
          case "/quit":
            stopping = true;
            continue;
          default:
            if (commandName === "/archive") {
              await archiveCurrentChat(contextLine, commandArgument);
              continue;
            }
            if (commandName === "/resume") {
              if (!commandArgument) {
                const selectedArchive = await pickArchive(contextLine);
                if (!selectedArchive) {
                  appendTranscript(chalk.yellow("[ultron] no archive selected.\n\n"));
                  continue;
                }
                try {
                  const messageCount = await resumeThread(graph, currentChatId, selectedArchive);
                  await showRestoredMessages(graph, currentChatId);
                  appendTranscript(chalk.dim(`[ultron] resumed ${messageCount} messages.\n\n`));
                } catch (error) {
                  appendTranscript(chalk.red(`[ultron] could not resume archive: ${error instanceof Error ? error.message : String(error)}\n\n`));
                }
                continue;
              }
              try {
                const messageCount = await resumeThread(graph, currentChatId, commandArgument);
                await showRestoredMessages(graph, currentChatId);
                appendTranscript(chalk.dim(`[ultron] resumed ${messageCount} messages from ${commandArgument}\n\n`));
              } catch (error) {
                appendTranscript(chalk.red(`[ultron] could not resume archive: ${error instanceof Error ? error.message : String(error)}\n\n`));
              }
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
              appendTranscript(chalk.dim(`[ultron] reasoning mode set to ${thinkingMode}.\n\n`));
              continue;
            }
            if (command.startsWith("/task ")) {
              const mode = command.slice("/task ".length).trim();
              if (mode !== "none" && mode !== "todo" && mode !== "plan") {
                appendTranscript(chalk.yellow("[ultron] use /task none, /task todo or /task plan.\n\n"));
                continue;
              }
              taskMode = mode;
              // Task mode applies to the next user request. Drop any list
              // left by an earlier request now, before it can be mistaken
              // for the plan of the new one.
              if (mode === "todo" || mode === "plan") todos.clear(currentChatId);
              appendTranscript(chalk.dim(`[ultron] task mode set to ${taskMode}.\n\n`));
              continue;
            }
            if (command.startsWith("/security ")) {
              const mode = command.slice("/security ".length).trim();
              if (mode !== "bypass" && mode !== "accept_edit" && mode !== "manual") {
                appendTranscript(chalk.yellow("[ultron] use /security bypass, /security accept_edit or /security manual.\n\n"));
                continue;
              }
              chats.setSecurityMode(currentChatId, mode);
              appendTranscript(chalk.dim(`[ultron] tool approval set to ${mode}.\n\n`));
              continue;
            }
            if (commandName === "/goal") {
              const goalArgument = commandArgument;
              const [subRaw, ...restWords] = goalArgument.split(/\s+/);
              const sub = (subRaw ?? "").toLowerCase();

              if (!goalArgument || sub === "status") {
                appendTranscript(chalk.dim(`[ultron] goal: ${goalStatusLine(goals.get(currentChatId))}\n\n`));
                continue;
              }
              if (sub === "clear") {
                goals.clear(currentChatId);
                appendTranscript(chalk.dim("[ultron] goal cleared.\n\n"));
                continue;
              }
              if (sub === "pause") {
                const goal = goals.get(currentChatId);
                if (!goal || goal.status !== "active") {
                  appendTranscript(chalk.yellow("[ultron] no active goal to pause.\n\n"));
                  continue;
                }
                goals.pause(currentChatId, restWords.join(" ") || "user-paused");
                appendTranscript(chalk.dim("[ultron] goal paused.\n\n"));
                continue;
              }
              if (sub === "resume") {
                const resumed = goals.resume(currentChatId);
                if (!resumed) {
                  appendTranscript(chalk.yellow("[ultron] no paused goal to resume.\n\n"));
                  continue;
                }
                appendTranscript(chalk.dim(`[ultron] goal resumed: ${resumed.objective}\n\n`));
                // Falls through to the normal send path below, same as
                // /retry — this becomes a real turn in the chat, not a
                // silent internal replay.
                input = buildContinuationPrompt(resumed.objective, "resumed by the user — pick up where you left off");
                break;
              }

              // Anything else: the whole argument is a new objective.
              const existing = goals.get(currentChatId);
              if (existing && (existing.status === "active" || existing.status === "paused")) {
                appendTranscript(
                  chalk.yellow(`[ultron] a goal is already ${existing.status} — /goal clear it first, or /goal pause/resume it.\n\n`),
                );
                continue;
              }
              goals.set(currentChatId, goalArgument, config.goalMaxTurns);
              appendTranscript(
                chalk.greenBright(
                  `[ultron] goal set — I'll work it and self-check until it's done or blocked (max ${config.goalMaxTurns} turns).\n\n`,
                ),
              );
              input = goalArgument;
              break;
            }
            if (command === "/verbose on" || command === "/verbose true") {
              verbose = true;
              appendTranscript(chalk.dim("[ultron] verbose on.\n\n"));
              continue;
            }
            if (command === "/verbose off" || command === "/verbose false") {
              verbose = false;
              appendTranscript(chalk.dim("[ultron] verbose off.\n\n"));
              continue;
            }
            appendTranscript(chalk.yellow(`[ultron] unknown command: ${input.trim()} — try /help\n\n`));
            continue;
        }
      }

      if (command !== "/retry") chats.maybeAutoTitle(currentChatId, input);
      chats.touch(currentChatId);

      // The selector describes the current request, not the whole chat.
      // Reset persisted task state at this boundary so an interrupted or
      // completed request cannot make the next one resume an old plan.
      if (command !== "/retry" && (taskMode === "todo" || taskMode === "plan")) todos.clear(currentChatId);

      const turnInput: { messages: HumanMessage[] } | Command = {
        messages: command === "/retry" ? [] : [new HumanMessage(input)],
      };
      const result = await executeTurn(currentChatId, turnInput, contextLine);
      // A goal stays "active" in the DB across an aborted/interrupted turn
      // (see driveGoalLoop's early returns) — checked fresh here rather than
      // trusting a stale in-memory flag, so /goal, /goal resume, and a plain
      // message sent while a goal happens to be active all converge on the
      // same auto-continuation path.
      if (!result.aborted && !result.errored && goals.get(currentChatId)?.status === "active") {
        await driveGoalLoop(currentChatId, contextLine, result.finalText);
      }
    }
  } finally {
    cancelActiveInput?.();
    appendTranscript(chalk.dim("[ultron] stopped.\n"));
    stdout.write(chalk.dim("[ultron] stopped.\n"));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red("[ultron] fatal error:"), err);
  process.exit(1);
});
