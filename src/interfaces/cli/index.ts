import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
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
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { DEFAULT_CHAT_TITLE, getChatRegistry, LEGACY_CHAT_ID, type Chat, type SecurityMode } from "../../core/memory/chats.js";
import { getGoalRegistry, type Goal } from "../../core/memory/goals.js";
import { getTodoRegistry } from "../../core/memory/todos.js";
import { buildContinuationPrompt, gatherCodeContext, judgeGoal } from "../../core/goalJudge.js";
import { disableConsoleEcho } from "../../core/logger.js";
import { tools } from "../../core/tools/index.js";
import { summarizeToolCall } from "../../core/tools/summarize.js";
import { listSkills, readSkill } from "../../core/skills.js";
import { listHubSkills, installHubSkill, type HubSkill } from "../../core/skillsHub.js";
import { MarkdownStreamRenderer } from "./markdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_BAR_WIDTH = 20;
const INPUT_PROMPT = `${chalk.cyanBright.bold("you")} ${chalk.dim("›")} `;
const LOCAL_COMMANDS = ["/help", "/model", "/status", "/clear", "/context", "/stop", "/retry", "/compact", "/archive", "/resume", "/think", "/task", "/theme", "/permissions", "/security", "/verbose", "/memory", "/quit"];

let cancelActiveInput: (() => void) | undefined;
let transcript = "";
// The most recently written tool-call block (input summary + result) that
// hasn't collapsed yet — tracked as a [start, end) range in `transcript` so
// it can be spliced down to a one-line `[toolName]` the moment anything
// follows it (more text, another tool call, or the next turn's message).
// Only the very last tool block on screen stays expanded.
let danglingToolBlock: { start: number; end: number; label: string } | null = null;
let bannerTranscript = "";
let generationInput = "";
let generationCursor = 0;
const promptHistory: string[] = [];
let latestRender: { input: string; cursor: number; contextLine: string } = { input: "", cursor: 0, contextLine: "" };
let pendingRender: { input: string; cursor: number; contextLine: string } | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let activePrompt = INPUT_PROMPT;
let activeModeLabel = "None";
let activePermissionLabel: SecurityMode = "bypass";
type TerminalTheme = "auto" | "light" | "dark";
let terminalTheme: TerminalTheme = "auto";
let activePickerRedraw: (() => void) | undefined;

// Inline "@skill" mention picker for the main composer only (gated on
// activePrompt === INPUT_PROMPT in drawScreen/onKeypress below) — unlike the
// other pickers (chat/model/permissions), this lives inside the normal
// readInput loop instead of taking it over, since typing must keep working
// normally around it. mentionSelected/mentionDismissed are read and written
// from both drawScreen (render) and onKeypress (navigation), mirroring how
// the rest of this file already shares render state across module-level
// mutable variables rather than threading it through every call.
let mentionSelected = 0;
let mentionDismissed = false;
let lastMentionQuery: string | undefined;
const MENTION_MAX_VISIBLE = 6;

interface MentionMatch {
  start: number;
  query: string;
}

interface MentionEntry {
  name: string;
  description: string;
  source: "local" | "hub";
}

// A mention token is "@" plus following non-whitespace, anchored at the
// start of the input or right after whitespace, with the cursor still
// inside it — so "foo@bar" mid-word doesn't trigger it, and moving the
// cursor past the token (e.g. by typing a space) closes the panel.
function activeMentionQuery(input: string, cursor: number): MentionMatch | undefined {
  const uptoCursor = input.slice(0, cursor);
  const at = uptoCursor.lastIndexOf("@");
  if (at === -1) return undefined;
  if (at > 0 && !/\s/.test(uptoCursor[at - 1])) return undefined;
  const query = uptoCursor.slice(at + 1);
  if (/\s/.test(query)) return undefined;
  return { start: at, query };
}

// listHubSkills() has its own hour-long cache/in-flight dedup (see
// skillsHub.ts), but it's still a network round trip on first use — kept
// out of the synchronous render path entirely. Fetched once per process,
// then merged into mentionPanelState's local filtering; the panel just
// shows local-only results until this resolves, then redraws once via
// latestRender (the module's "last known render call", already used by
// flushRender) so hub results appear without the user needing to type
// another character.
let hubSkillsCache: HubSkill[] = [];
let hubSkillsLoaded = false;

function ensureHubSkillsLoaded(): void {
  if (hubSkillsLoaded) return;
  hubSkillsLoaded = true;
  listHubSkills()
    .then((skills) => {
      hubSkillsCache = skills;
      renderScreen(latestRender.input, latestRender.cursor, latestRender.contextLine);
    })
    .catch(() => {
      /* offline or GitHub unreachable — listHubSkills() already resolves []
         on failure instead of rejecting; this catch is just a safety net. */
    });
}

// Single source of truth for both drawScreen (rendering) and onKeypress
// (deciding whether to intercept up/down/enter/tab/escape) — computing it
// twice per keystroke with separate logic would risk the two drifting out
// of sync. Resets selection/dismissal state as a side effect whenever the
// query text changes, so an in-progress selection doesn't survive typing
// more characters. Local skills are shown before hub ones, and a hub skill
// already installed locally is deduplicated in favor of the local entry.
function mentionPanelState(input: string, cursor: number): { mention: MentionMatch; matches: MentionEntry[] } | undefined {
  const mention = activeMentionQuery(input, cursor);
  if (!mention) {
    lastMentionQuery = undefined;
    mentionDismissed = false;
    return undefined;
  }
  if (mention.query !== lastMentionQuery) {
    lastMentionQuery = mention.query;
    mentionSelected = 0;
    mentionDismissed = false;
  }
  ensureHubSkillsLoaded();
  const query = mention.query.toLowerCase();
  const local = listSkills().filter((skill) => skill.name.toLowerCase().includes(query));
  const localNames = new Set(local.map((skill) => skill.name));
  const hub = hubSkillsCache.filter((skill) => !localNames.has(skill.name) && skill.name.toLowerCase().includes(query));
  // Full list, not sliced to the visible window here — slicing before
  // wrapping selection around matches.length was the bug: with more than
  // MENTION_MAX_VISIBLE results, arrow navigation could never reach
  // anything past the first window. drawScreen computes a scrolling
  // sub-window around mentionSelected for display; selection itself always
  // covers every match.
  const matches: MentionEntry[] = [
    ...local.map((skill) => ({ name: skill.name, description: skill.description, source: "local" as const })),
    ...hub.map((skill) => ({ name: skill.name, description: skill.description, source: "hub" as const })),
  ];
  mentionSelected = matches.length ? Math.min(mentionSelected, matches.length - 1) : 0;
  return { mention, matches };
}

function applyMentionSelection(
  value: string,
  cursor: number,
  mention: MentionMatch,
  name: string,
): { value: string; cursor: number } {
  const before = value.slice(0, mention.start);
  const after = value.slice(cursor);
  const inserted = `@${name} `;
  return { value: before + inserted + after, cursor: before.length + inserted.length };
}

// Shared by both places text gets typed with a live mention panel possibly
// showing: the normal composer (readInput) and the limited input accepted
// while a turn is generating (armStopCommand). Originally this logic only
// lived inside readInput's onKeypress, so the panel would render during
// generation (drawScreen doesn't care which loop is driving it) but arrow
// keys did nothing there — this had no code path to reach. Returns true if
// the keypress was fully handled (including its own re-render), so the
// caller should stop processing it any further.
async function handleMentionKeypress(
  key: readline.Key,
  value: string,
  cursor: number,
  setValue: (value: string, cursor: number) => void,
  contextLine: string,
): Promise<boolean> {
  if (activePrompt !== INPUT_PROMPT) return false;
  const activeMention = mentionPanelState(value, cursor);
  if (!activeMention || mentionDismissed) return false;

  if (key.name === "escape") {
    mentionDismissed = true;
    renderScreen(value, cursor, contextLine);
    return true;
  }
  if (!activeMention.matches.length) return false;
  if (key.name === "up") {
    mentionSelected = (mentionSelected - 1 + activeMention.matches.length) % activeMention.matches.length;
    renderScreen(value, cursor, contextLine);
    return true;
  }
  if (key.name === "down") {
    mentionSelected = (mentionSelected + 1) % activeMention.matches.length;
    renderScreen(value, cursor, contextLine);
    return true;
  }
  if (key.name === "tab" || key.name === "return" || key.name === "enter") {
    const entry = activeMention.matches[mentionSelected];
    // A hub skill isn't on disk yet — install it (writes
    // skills/<name>/SKILL.md, see skillsHub.ts) before inserting the
    // mention, so expandSkillMentions can find it at send time the same
    // way it finds any other local skill.
    if (entry.source === "hub") {
      appendTranscript(uiDim(`[ultron] installing skill "${entry.name}" from anthropics/skills…\n`));
      renderScreen(value, cursor, contextLine);
      flushRender();
      const installed = await installHubSkill(entry.name);
      appendTranscript(
        installed
          ? uiDim(`[ultron] skill "${entry.name}" installed to skills/${entry.name}/SKILL.md.\n\n`)
          : chalk.yellow(`[ultron] failed to install skill "${entry.name}" — inserted as text only.\n\n`),
      );
    }
    const applied = applyMentionSelection(value, cursor, activeMention.mention, entry.name);
    setValue(applied.value, applied.cursor);
    renderScreen(applied.value, applied.cursor, contextLine);
    return true;
  }
  return false;
}

// Expands every "@skill-name" mention still present in a message about to
// be sent into the skill's full body, injected as its own tagged block
// right after the user's text — deterministic, not a hope that the model
// calls skill_read on its own. Mirrors the task-mode directive pattern: the
// user's explicit choice (picking a skill from the panel, or just typing
// its name) drives behavior instead of model inference. Unmatched "@word"
// tokens (not a real skill name) are left as plain text.
function expandSkillMentions(message: string): string {
  const names = new Set(listSkills().map((skill) => skill.name));
  const mentioned = new Set<string>();
  for (const match of message.matchAll(/(?:^|\s)@([\w-]+)/g)) {
    if (names.has(match[1])) mentioned.add(match[1]);
  }
  if (!mentioned.size) return message;
  const blocks = [...mentioned].map((name) => `<skill name="${name}">\n${readSkill(name)}\n</skill>`);
  return `${message}\n\n---\n${blocks.join("\n\n")}`;
}

function isLightTerminal(): boolean {
  if (terminalTheme === "light") return true;
  if (terminalTheme === "dark") return false;
  // COLORFGBG conventionally stores foreground;background; a background
  // value of 15 is the usual white terminal background.
  return /(?:^|[;:])15$/.test(process.env.COLORFGBG ?? "");
}

function uiDim(text: string): string {
  return isLightTerminal() ? chalk.gray(text) : chalk.dim(text);
}

function uiWhite(text: string): string {
  return isLightTerminal() ? chalk.blackBright(text) : chalk.whiteBright(text);
}

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

function modeInputColor(): (text: string) => string {
  if (activeModeLabel === "To-Do") return isLightTerminal() ? chalk.yellow : chalk.yellowBright;
  if (activeModeLabel === "Plan") return isLightTerminal() ? chalk.blue : chalk.blueBright;
  if (activeModeLabel === "Goal") return isLightTerminal() ? chalk.green : chalk.greenBright;
  return isLightTerminal() ? chalk.cyan : chalk.cyanBright;
}

function permissionColor(permission: SecurityMode): (text: string) => string {
  if (permission === "bypass") return isLightTerminal() ? chalk.red : chalk.redBright;
  if (permission === "accept_edit") return isLightTerminal() ? chalk.yellow : chalk.yellowBright;
  return isLightTerminal() ? chalk.green : chalk.greenBright;
}

function statusContextLine(contextLine: string): string {
  return `${contextLine}  ${modeInputColor()(activeModeLabel)}  ${permissionColor(activePermissionLabel)(activePermissionLabel)}`;
}

function drawScreen(input: string, cursor: number, contextLine: string): void {
  const content = transcript.endsWith("\n") ? transcript : `${transcript}\n`;
  // Only show the completion when the cursor is at the end of the command:
  // that keeps the ghost text from appearing in the middle of an edited line.
  const suggestion = cursor === input.length ? commandSuggestion(input) : "";
  const suggestionSuffix = suggestion ? uiDim(suggestion.slice(input.length)) : "";
  const displayContextLine = statusContextLine(contextLine);

  // Gated to the main composer only (see mentionPanelState's comment) — the
  // y/n confirm and title prompts reuse readInput with a different prompt
  // and shouldn't grow a skills panel underneath them.
  const mentionPanel = activePrompt === INPUT_PROMPT ? mentionPanelState(input, cursor) : undefined;
  const mentionLines: string[] =
    mentionPanel && !mentionDismissed
      ? [
          `${uiDim("skills · type to filter · ↑/↓ select · Enter/Tab insert · Esc dismiss")}${mentionPanel.matches.length > MENTION_MAX_VISIBLE ? uiDim(` · ${mentionSelected + 1}/${mentionPanel.matches.length}`) : ""}`,
          ...(mentionPanel.matches.length
            ? (() => {
                // Scrolling window centered on the selection so arrowing
                // past the bottom of the visible rows keeps moving instead
                // of wrapping within a fixed slice — see mentionPanelState's
                // comment for why matches itself is never pre-sliced.
                const total = mentionPanel.matches.length;
                const windowStart =
                  total <= MENTION_MAX_VISIBLE
                    ? 0
                    : Math.min(Math.max(0, mentionSelected - Math.floor(MENTION_MAX_VISIBLE / 2)), total - MENTION_MAX_VISIBLE);
                return mentionPanel.matches.slice(windowStart, windowStart + MENTION_MAX_VISIBLE).map((entry, i) => {
                  const index = windowStart + i;
                  const marker = index === mentionSelected ? chalk.greenBright("›") : " ";
                  const label = index === mentionSelected ? chalk.cyanBright.bold(entry.name) : entry.name;
                  const tag = entry.source === "hub" ? ` ${uiDim("(hub)")}` : "";
                  return `  ${marker} ${label}${tag}`;
                });
              })()
            : [uiDim("  no matching skills")]),
        ]
      : [];
  const mentionBlock = mentionLines.length ? `\n${mentionLines.join("\n")}` : "";

  const footer = `${rule()}\n${activePrompt}${input}${suggestionSuffix}${mentionBlock}\n${displayContextLine}\n${rule()}`;
  const footerRows = footer.split("\n").reduce((rows, line) => rows + wrappedRows(line), 0);
  const rows = stdout.rows || 24;
  const padding = Math.max(0, rows - transcriptRows(content) - footerRows);

  // Draw up to the input first. Save that exact terminal position before
  // drawing the lines below it, then restore it; this avoids all vertical
  // cursor arithmetic and the terminal-specific wrap off-by-ones it caused.
  const inputLine = activePrompt + uiWhite(input) + suggestionSuffix;
  stdout.write(`\x1b[2J\x1b[H${content}${"\n".repeat(padding)}${rule()}\n${inputLine}`);
  const promptWidth = stripAnsi(activePrompt).length + cursor;
  const width = Math.max(1, stdout.columns || 80);
  stdout.write(`${mentionBlock}\n${displayContextLine}\n${rule()}`);
  // The cursor is now on the last footer line. Return to the input by the
  // number of footer lines actually written; avoid save/restore sequences,
  // which are not restored consistently by every terminal emulator.
  const mentionRows = mentionLines.reduce((rows, line) => rows + wrappedRows(line), 0);
  const footerAfterInputRows = mentionRows + wrappedRows(displayContextLine) + wrappedRows(rule());
  readline.moveCursor(stdout, 0, -footerAfterInputRows);
  readline.cursorTo(stdout, promptWidth % width);
}

function renderScreen(input: string, cursor: number, contextLine: string): void {
  latestRender = { input, cursor, contextLine };
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
  return Math.max(1, (stdout.columns || 80) - 1);
}

function rule(): string {
  return uiDim("─".repeat(ruleWidth()));
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
    let historyIndex = -1;
    let historyDraft = "";
    let finished = false;

    const finish = (result: string, keepHistory = true) => {
      if (finished) return;
      finished = true;
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      cancelActiveInput = undefined;

      if (keepHistory && recordHistory && result.trim()) {
        if (promptHistory.at(-1) !== result) promptHistory.push(result);
        appendTranscript(`${activePrompt}${result}\n`);
      }
      renderScreen("", 0, contextLine);
      flushRender();
      activePrompt = INPUT_PROMPT;
      resolve(result);
    };

    // async: the "insert a hub skill" branch below awaits installHubSkill()
    // (a network fetch) before finishing the keystroke. Node's EventEmitter
    // doesn't await listeners, so other keypresses can still arrive and run
    // while this is in flight — acceptable for a single-user local CLI, and
    // installHubSkill() itself is a plain overwrite, safe to double-fire.
    const onKeypress = async (input: string, key: readline.Key) => {
      // Uses value/cursor as they stood before this keystroke, i.e. exactly
      // what's currently on screen — correct here since none of the keys
      // handleMentionKeypress intercepts mutate text themselves.
      if (await handleMentionKeypress(key, value, cursor, (v, c) => { value = v; cursor = c; }, contextLine)) return;
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
      if (key.name === "up") {
        if (!recordHistory || promptHistory.length === 0) return;
        if (historyIndex === -1) {
          historyDraft = value;
          historyIndex = promptHistory.length;
        }
        if (historyIndex > 0) historyIndex--;
        value = promptHistory[historyIndex];
        cursor = value.length;
        renderScreen(value, cursor, contextLine);
        return;
      }
      if (key.name === "down") {
        if (!recordHistory || historyIndex === -1) return;
        if (historyIndex < promptHistory.length - 1) {
          historyIndex++;
          value = promptHistory[historyIndex];
        } else {
          historyIndex = -1;
          value = historyDraft;
        }
        cursor = value.length;
        renderScreen(value, cursor, contextLine);
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

// Backs /resume: browse archived chats, invoke one (Enter — unarchives it
// and returns it as the new current chat, with its full LangGraph
// checkpoint state intact, not a lossy text reconstruction) or delete one
// (Ctrl+D — purges it via chats.delete, including its checkpoint rows, and
// keeps the picker open on the remaining list). Mirrors the CLI's other
// arrow-key pickers (same keyboard/search/redraw behavior).
function pickArchivedChat(contextLine: string, chats: ReturnType<typeof getChatRegistry>): Promise<Chat | undefined> {
  let archived = chats.listArchived();
  if (archived.length === 0) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let query = "";
    let selected = 0;
    let finished = false;

    const redraw = () => {
      const matches = archived.filter((chat) => chat.title.toLowerCase().includes(query.toLowerCase()));
      selected = Math.min(selected, Math.max(0, matches.length - 1));
      const rows = matches.length
        ? matches
            .map((chat, index) => {
              const marker = index === selected ? chalk.greenBright("›") : " ";
              return `  ${marker} ${chat.title}`;
            })
            .join("\n")
        : uiDim("  no matching archived chats");
      const prompt = `${chalk.magentaBright.bold("resume")} ${uiDim("›")} `;
      const content = transcript.endsWith("\n") ? transcript : `${transcript}\n`;
      const picker = `${uiDim("Select an archived chat · type to search · ↑/↓ navigate · Enter to resume · Ctrl+D to delete")}\n${rows}`;
      const footer = `${rule()}\n${prompt}${query}\n${contextLine}\n${rule()}`;
      const padding = Math.max(0, (stdout.rows || 24) - transcriptRows(content + `${picker}\n`) - 4);
      stdout.write(`\x1b[2J\x1b[H${content}${picker}\n${"\n".repeat(padding)}${footer}`);
      readline.moveCursor(stdout, 0, -2);
      readline.cursorTo(stdout, prompt.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length + query.length);
    };

    const finish = (chat?: Chat) => {
      if (finished) return;
      finished = true;
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      cancelActiveInput = undefined;
      renderScreen("", 0, contextLine);
      flushRender();
      resolve(chat);
    };

    const onKeypress = (input: string, key: readline.Key) => {
      const matches = archived.filter((chat) => chat.title.toLowerCase().includes(query.toLowerCase()));
      if (key.ctrl && key.name === "d") {
        const target = matches[selected];
        if (target) {
          chats.delete(target.id);
          archived = archived.filter((chat) => chat.id !== target.id);
          if (archived.length === 0) { finish(); return; }
        }
        redraw();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(matches[selected]);
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

interface NvidiaModelInfo {
  id: string;
  contextWindowTokens?: number;
}

const modelContextCache = new Map<string, number | undefined>();

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

function pickModel(contextLine: string, models: NvidiaModelInfo[], currentModel: string): Promise<NvidiaModelInfo | undefined> {
  const MAX_VISIBLE_MODELS = 18;

  return new Promise((resolve) => {
    let query = "";
    let selected = Math.max(0, models.findIndex((model) => model.id === currentModel));
    let finished = false;

    const getMatches = () => models.filter((model) => model.id.toLowerCase().includes(query.toLowerCase()));

    const redraw = () => {
      const matches = getMatches();
      const visible = matches.slice(0, MAX_VISIBLE_MODELS);
      selected = Math.min(selected, Math.max(0, visible.length - 1));
      const rows = visible.length
        ? visible
            .map((model, index) => {
              const marker = index === selected ? chalk.greenBright("›") : " ";
              const label = index === selected ? chalk.cyanBright.bold(model.id) : model.id;
              const context = model.contextWindowTokens ? ` ${uiDim(`· ${model.contextWindowTokens.toLocaleString()} tokens`)}` : "";
              const current = model.id === currentModel ? ` ${uiDim("(current)")}` : "";
              return `  ${marker} ${label}${context}${current}`;
            })
            .join("\n")
        : uiDim("  no matching NVIDIA models");
      const count = matches.length > MAX_VISIBLE_MODELS ? ` · showing ${MAX_VISIBLE_MODELS}/${matches.length}` : "";
      const content = transcript.endsWith("\n") ? transcript : `${transcript}\n`;
      const picker = `${uiDim(`NVIDIA models · type to search · ↑/↓ select · Enter confirm · Esc cancel${count}`)}\n${rows}`;
      const prompt = `${chalk.magentaBright.bold("model")} ${uiDim("›")} `;
      const footer = `${rule()}\n${prompt}${query}\n${statusContextLine(contextLine)}\n${rule()}`;
      const padding = Math.max(0, (stdout.rows || 24) - transcriptRows(content + `${picker}\n`) - 4);
      stdout.write(`\x1b[2J\x1b[H${content}${picker}\n${"\n".repeat(padding)}${footer}`);
      readline.moveCursor(stdout, 0, -2);
      readline.cursorTo(stdout, stripAnsi(prompt).length + query.length);
    };

    const finish = (value?: NvidiaModelInfo) => {
      if (finished) return;
      finished = true;
      activePickerRedraw = undefined;
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      cancelActiveInput = undefined;
      renderScreen("", 0, contextLine);
      flushRender();
      resolve(value);
    };

    const onKeypress = (input: string, key: readline.Key) => {
      const matches = getMatches().slice(0, MAX_VISIBLE_MODELS);
      if (key.name === "return" || key.name === "enter") {
        finish(matches[selected]);
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
    activePickerRedraw = redraw;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.on("keypress", onKeypress);
    redraw();
  });
}

const PERMISSION_OPTIONS: { value: SecurityMode; description: string }[] = [
  { value: "bypass", description: "run every tool immediately" },
  { value: "accept_edit", description: "ask before destructive tools" },
  { value: "manual", description: "ask before every tool" },
];

function pickPermission(contextLine: string, current: SecurityMode): Promise<SecurityMode | undefined> {
  return new Promise((resolve) => {
    let selected = Math.max(0, PERMISSION_OPTIONS.findIndex((option) => option.value === current));
    let finished = false;

    const redraw = () => {
      const rows = PERMISSION_OPTIONS.map((option, index) => {
        const marker = index === selected ? chalk.greenBright("›") : " ";
        const value = permissionColor(option.value)(index === selected ? chalk.bold(option.value) : option.value);
        return `  ${marker} ${value}  ${uiDim(option.description)}`;
      }).join("\n");
      const content = transcript.endsWith("\n") ? transcript : `${transcript}\n`;
      const picker = `${uiDim("Permissions · ↑/↓ select · Enter confirm · Esc cancel")}\n${rows}`;
      const permissionContext = statusContextLine(contextLine);
      const footer = `${rule()}\n${uiDim("permissions")} ${uiDim("›")} ${PERMISSION_OPTIONS[selected].value}\n${permissionContext}\n${rule()}`;
      const padding = Math.max(0, (stdout.rows || 24) - transcriptRows(content + `${picker}\n`) - 4);
      stdout.write(`\x1b[2J\x1b[H${content}${picker}\n${"\n".repeat(padding)}${footer}`);
      readline.moveCursor(stdout, 0, -2);
      readline.cursorTo(stdout, uiDim("permissions").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length + 1 + uiDim("›").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length + PERMISSION_OPTIONS[selected].value.length);
    };

    const finish = (value?: SecurityMode) => {
      if (finished) return;
      finished = true;
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      cancelActiveInput = undefined;
      renderScreen("", 0, contextLine);
      flushRender();
      resolve(value);
    };

    const onKeypress = (_input: string, key: readline.Key) => {
      if (key.name === "return" || key.name === "enter") {
        finish(PERMISSION_OPTIONS[selected].value);
      } else if (key.name === "escape") {
        finish();
      } else if (key.name === "up") {
        selected = (selected - 1 + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length;
        redraw();
      } else if (key.name === "down") {
        selected = (selected + 1) % PERMISSION_OPTIONS.length;
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
  danglingToolBlock = null;
  printBanner();
  // Same collapse rule as the live stream: only the very last tool block in
  // the whole history is still "the latest thing on screen" and stays
  // expanded — every earlier one is followed by something, so it renders
  // collapsed straight away instead of expanding then re-collapsing.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "human") {
      appendTranscript(`${INPUT_PROMPT}${message.content}\n`);
    } else if (message.role === "ai") {
      appendTranscript(`${chalk.redBright.bold("ultron")} ${uiDim("›")} ${message.content}\n\n`);
    } else if (message.role === "tool_call") {
      const isLastBlock = i + 1 === messages.length - 1;
      if (isLastBlock) appendTranscript(uiDim(`[${message.content}]\n`));
    } else {
      const isLastBlock = i === messages.length - 1;
      appendTranscript(
        isLastBlock
          ? `${formatToolResult(message.name ?? "tool", message.content)}\n\n`
          : `${collapsedToolLine(message.name ?? "tool")}\n\n`,
      );
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
    const list = items.map((item, i) => `  ${uiDim(`${i + 1}.`)} ${item.content ?? String(item)}`).join("\n");
    appendTranscript(`${chalk.yellowBright.bold(`[ultron] plan proposed · ${items.length} step${items.length === 1 ? "" : "s"}`)}\n${list}\n`);
    renderScreen("", 0, contextLine);
    flushRender();

    const answer = (
      await readInput(contextLine, "", `${chalk.yellowBright.bold("start?")} ${uiDim("(y/n) ›")} `, false)
    )
      .trim()
      .toLowerCase();
    const approved = answer === "y" || answer === "yes";
    appendTranscript(
      uiDim(approved ? "[ultron] plan started.\n\n" : "[ultron] plan not approved — discuss changes, then it can be re-proposed.\n\n"),
    );
    return { [calls[0].id]: approved };
  }

  const list = calls
    .map((c) => `  ${chalk.yellow("•")} ${chalk.bold(c.name)} ${uiDim(JSON.stringify(c.args))}`)
    .join("\n");
  appendTranscript(`${chalk.yellowBright.bold("[ultron] approval required")}\n${list}\n`);
  renderScreen("", 0, contextLine);
  flushRender();

  const answer = (
    await readInput(contextLine, "", `${chalk.yellowBright.bold("approve?")} ${uiDim("(y/n) ›")} `, false)
  )
    .trim()
    .toLowerCase();
  const approved = answer === "y" || answer === "yes";
  appendTranscript(uiDim(`[ultron] ${approved ? "approved" : "denied"} ${calls.length} tool call(s).\n\n`));

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
  return `${out}\n${uiDim(`… (${omitted.toLocaleString()} more characters not shown — full result is still in context)`)}`;
}

// Numbered-result blocks from formatSearchResults (search.ts): "source: X",
// then "N. Title" / "   https://…" / "   metadata" / "   snippet" groups.
function styleSearchResults(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (/^source: /.test(line)) return uiDim(line);
      if (/^\d+\.\s/.test(line)) return uiWhite(line);
      const urlMatch = line.match(/^(\s*)(https?:\/\/\S+)$/);
      if (urlMatch) return `${urlMatch[1]}${chalk.cyan.underline(urlMatch[2])}`;
      return uiDim(line);
    })
    .join("\n");
}

// fetch_url/http_request's "status: …\nurl: …\n\n<body>" header.
function styleFetchResult(content: string): string {
  const [head, ...rest] = content.split("\n\n");
  const styledHead = head
    .split("\n")
    .map((line) => uiDim(line))
    .join("\n");
  const body = rest.join("\n\n");
  return body ? `${styledHead}\n\n${capForDisplay(body)}` : styledHead;
}

function collapsedToolLine(name: string): string {
  return uiDim(`[${name}]`);
}

function collapseDanglingToolBlock(): void {
  if (!danglingToolBlock) return;
  const { start, end, label } = danglingToolBlock;
  transcript = transcript.slice(0, start) + `${collapsedToolLine(label)}\n\n` + transcript.slice(end);
  danglingToolBlock = null;
}

function formatToolResult(name: string, content: string): string {
  if (name === "web_search") return `${chalk.cyanBright.bold("[search]")}\n${styleSearchResults(capForDisplay(content))}`;
  if (name === "fetch_url" || name === "http_request") return `${chalk.blueBright.bold("[fetch]")}\n${styleFetchResult(content)}`;
  if (name === "spawn_agent") return `${chalk.magentaBright.bold("[agent]")} ${content}`;
  return `${uiDim(`[tool result · ${name}]`)}\n${capForDisplay(content)}`;
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
  const bar = fillColor("█".repeat(filled)) + uiDim("░".repeat(CONTEXT_BAR_WIDTH - filled));
  const pct = Math.round(ratio * 100);
  const maxLabel =
    maxTokens >= 1_000_000
      ? `${maxTokens / 1_000_000}M`
      : maxTokens >= 1000
        ? `${Math.round(maxTokens / 1000)}k`
        : String(maxTokens);
  return `${uiDim("context")}  ${bar}  ${usedTokens.toLocaleString()} / ${maxLabel} tokens (${fillColor(`${pct}%`)})`;
}

function fitAsciiArt(art: string, availableWidth: number): string {
  const lines = art.split("\n");
  const sourceWidth = Math.max(...lines.map((line) => Array.from(line).length), 1);
  const targetWidth = Math.min(sourceWidth, Math.max(1, availableWidth));
  if (targetWidth === sourceWidth) return art;

  const scale = targetWidth / sourceWidth;
  const targetHeight = Math.max(1, Math.round(lines.length * scale));
  const sourceLines = lines.map((line) => {
    const chars = Array.from(line);
    return chars.concat(" ".repeat(sourceWidth - chars.length));
  });

  return Array.from({ length: targetHeight }, (_, targetRow) => {
    const sourceRow = Math.min(lines.length - 1, Math.floor(targetRow / scale));
    const source = sourceLines[sourceRow];
    return Array.from({ length: targetWidth }, (_, targetColumn) => {
      const sourceColumn = Math.min(sourceWidth - 1, Math.floor(targetColumn / scale));
      return source[sourceColumn];
    }).join("").trimEnd();
  }).join("\n");
}

function buildBanner(): string {
  const sourceArt = readFileSync(join(__dirname, "ascii-art.txt"), "utf-8").trimEnd();
  const art = fitAsciiArt(sourceArt, (stdout.columns || 80) - 2);
  return `${art}\n\n  ${uiDim("model")}    ${config.nemotronModel}\n  ${uiDim("memory")}   MEMORY.md\n  ${uiDim("status")}   ${chalk.greenBright("ready")}\n\n${uiDim("  type a message to begin · ctrl+c to stop at any time")}\n\n`;
}

function printBanner() {
  bannerTranscript = buildBanner();
  appendTranscript(bannerTranscript);
}

function refreshBanner() {
  if (!bannerTranscript || !transcript.startsWith(bannerTranscript)) return;
  const oldBannerLength = bannerTranscript.length;
  const history = transcript.slice(oldBannerLength);
  transcript = "";
  printBanner();
  // The banner's length can change with terminal width — shift any tracked
  // tool-block offsets by the same delta so a resize mid-turn can't corrupt
  // the range collapseDanglingToolBlock() later splices.
  const delta = bannerTranscript.length - oldBannerLength;
  if (danglingToolBlock && delta !== 0) {
    danglingToolBlock = {
      ...danglingToolBlock,
      start: danglingToolBlock.start + delta,
      end: danglingToolBlock.end + delta,
    };
  }
  transcript += history;
}

stdout.on("resize", () => {
  if (activePickerRedraw) {
    activePickerRedraw();
    return;
  }
  refreshBanner();
  renderScreen(latestRender.input, latestRender.cursor, latestRender.contextLine);
  flushRender();
});

function printHelp() {
  appendTranscript(
    `${uiDim("  local commands")}\n  ${chalk.cyanBright("/help")}     show this help\n  ${chalk.cyanBright("/model")}    search and select an NVIDIA model\n  ${chalk.cyanBright("/status")}   show model, memory and tool status\n  ${chalk.cyanBright("/clear")}    clear the terminal and redraw the banner\n  ${chalk.cyanBright("/context")}  show context usage\n  ${chalk.cyanBright("/stop")}     stop the active generation\n  ${chalk.cyanBright("/retry")}    retry the last user message\n  ${chalk.cyanBright("/compact")}  summarize and compact session history\n  ${chalk.cyanBright("/archive")}  rename (optional), then archive the chat and start a new one\n  ${chalk.cyanBright("/resume")}   browse archived chats — Enter to resume, Ctrl+D to delete\n  ${chalk.cyanBright("/think")}    set reasoning: on, low or off\n  ${chalk.cyanBright("/task")}     set task mode: none, todo, plan or goal (goal: next message sent becomes the objective)\n  ${chalk.cyanBright("/theme")}    terminal theme: auto, light or dark\n  ${chalk.cyanBright("/permissions")} choose bypass, accept_edit or manual with ↑/↓ + Enter\n  ${chalk.cyanBright("/security")} set tool approval: bypass, accept_edit or manual\n  ${chalk.cyanBright("/verbose")}  toggle timing and token metrics\n  ${chalk.cyanBright("/memory")}   list, clear, or forget auto-accumulated observations about you\n  ${chalk.cyanBright("/quit")}     stop ULTRON\n\n`,
  );
}

// Shared by /status and /task goal (bare or "status") — same one-liner
// either way so the two surfaces never drift into describing the goal
// differently.
function goalStatusLine(goal: Goal | undefined): string {
  if (!goal || goal.status === "cleared") return "no active goal — /task goal, then send a message";
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
    `  ${uiDim("model")}    ${config.nemotronModel}\n  ${uiDim("memory")}   MEMORY.md · chat ${chatId}\n  ${uiDim("tools")}    ${tools.length} available\n  ${uiDim("think")}    ${thinkingMode}\n  ${uiDim("task")}     ${taskMode}\n  ${uiDim("security")} ${securityMode}\n  ${uiDim("goal")}     ${goalStatusLine(goal)}\n  ${uiDim("verbose")}  ${verbose ? "on" : "off"}\n  ${uiDim("status")}   ${chalk.greenBright("ready")}\n\n`,
  );
}

function armStopCommand(abort: AbortController, contextLine: string): () => void {
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  const onKeypress = async (input: string, key: readline.Key) => {
    if (key.ctrl && key.name === "c") {
      process.emit("SIGINT");
      return;
    }
    // Same skills panel as the normal composer (see readInput's onKeypress)
    // — the panel renders here too since drawScreen doesn't distinguish
    // which loop is driving it, so without this arrow keys/Enter/Tab had
    // nothing to intercept while a turn was generating.
    if (
      await handleMentionKeypress(
        key,
        generationInput,
        generationCursor,
        (v, c) => {
          generationInput = v;
          generationCursor = c;
        },
        contextLine,
      )
    )
      return;
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

  let graph = buildGraph();
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
  activePermissionLabel = chats.getSecurityMode(currentChatId);

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

  const archiveCurrentChat = async (contextLine: string, requestedTitle?: string): Promise<void> => {
    let title = requestedTitle?.trim();
    if (!title) {
      const chat = chats.get(currentChatId);
      const suggestedTitle = chat && chat.title !== DEFAULT_CHAT_TITLE ? chat.title : "";
      title = (
        await readInput(
          contextLine,
          suggestedTitle,
          `${chalk.magentaBright.bold("title")} ${uiDim("›")} `,
          false,
        )
      ).trim();
    }

    const archived = chats.archive(currentChatId, title || undefined);
    const nextChat = chats.create();
    currentChatId = nextChat.id;
    activePermissionLabel = chats.getSecurityMode(currentChatId);
    appendTranscript(`${chalk.greenBright(`Chat Archived "${archived?.title ?? title ?? ""}"`)}\n\n`);
  };

  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    appendTranscript(uiDim("\n[ultron] stopping...\n"));
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
    // A new turn means a new message followed whatever was last on screen —
    // collapse a tool block left dangling expanded at the end of the
    // previous turn.
    collapseDanglingToolBlock();
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
              danglingToolBlock = { start: blockStart, end: transcript.length, label: toolName };
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
            printStatus(thinkingMode, taskMode, verbose, currentChatId, chats.getSecurityMode(currentChatId), goals.get(currentChatId));
            continue;
          case "/clear":
            transcript = "";
            danglingToolBlock = null;
            printBanner();
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
          case "/archive": {
            await archiveCurrentChat(contextLine, commandArgument);
            continue;
          }
          case "/resume": {
            let target: Chat | undefined;
            if (!commandArgument) {
              target = await pickArchivedChat(contextLine, chats);
            } else {
              const query = commandArgument.toLowerCase();
              target = chats.listArchived().find((chat) => chat.id === commandArgument || chat.title.toLowerCase().includes(query));
            }
            if (!target) {
              appendTranscript(chalk.yellow("[ultron] no archived chat selected.\n\n"));
              continue;
            }
            chats.unarchive(target.id);
            currentChatId = target.id;
            activePermissionLabel = chats.getSecurityMode(currentChatId);
            await showRestoredMessages(graph, currentChatId);
            appendTranscript(uiDim(`[ultron] resumed "${target.title}".\n\n`));
            continue;
          }
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
            activePermissionLabel = selectedPermission;
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
            if (commandName === "/archive") {
              await archiveCurrentChat(contextLine, commandArgument);
              continue;
            }
            if (commandName === "/resume") {
              let target: Chat | undefined;
              if (!commandArgument) {
                target = await pickArchivedChat(contextLine, chats);
              } else {
                const query = commandArgument.toLowerCase();
                target = chats.listArchived().find((chat) => chat.id === commandArgument || chat.title.toLowerCase().includes(query));
              }
              if (!target) {
                appendTranscript(chalk.yellow("[ultron] no archived chat selected.\n\n"));
                continue;
              }
              chats.unarchive(target.id);
              currentChatId = target.id;
              activePermissionLabel = chats.getSecurityMode(currentChatId);
              await showRestoredMessages(graph, currentChatId);
              appendTranscript(uiDim(`[ultron] resumed "${target.title}".\n\n`));
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
              activeModeLabel = mode === "todo" ? "To-Do" : mode === "plan" ? "Plan" : mode === "goal" ? "Goal" : "None";
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
              activePermissionLabel = mode;
              appendTranscript(uiDim(`[ultron] tool approval set to ${mode}.\n\n`));
              continue;
            }
            if (command === "/theme") {
              appendTranscript(uiDim(`[ultron] terminal theme: ${terminalTheme} (${isLightTerminal() ? "light" : "dark"} palette).\n\n`));
              continue;
            }
            if (command.startsWith("/theme ")) {
              const theme = command.slice("/theme ".length).trim();
              if (theme !== "auto" && theme !== "light" && theme !== "dark") {
                appendTranscript(chalk.yellow("[ultron] use /theme auto, /theme light or /theme dark.\n\n"));
                continue;
              }
              terminalTheme = theme;
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
    appendTranscript(uiDim("[ultron] stopped.\n"));
    stdout.write(uiDim("[ultron] stopped.\n"));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red("[ultron] fatal error:"), err);
  process.exit(1);
});
