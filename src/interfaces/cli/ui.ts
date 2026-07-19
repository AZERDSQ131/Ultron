// Shared terminal rendering/state layer for both CLI entry points:
// index.ts (local — runs the graph in-process) and remote.ts (network — a
// thin HTTP/SSE client meant for the Mac). Everything here is intentionally
// backend-agnostic: it works on plain data shapes (PendingToolCall,
// ChatMessage, SecurityMode, Goal…) that already match both the local
// LangGraph-derived values AND the JSON the web API returns, so the two
// entry points can drive the exact same rendering code and look/behave
// identically — only *how a turn gets executed* differs between them, not
// how anything is drawn. Every type imported here is `import type` only
// (erased at compile time) specifically so this module never triggers
// graph.js's/config.js's/chats.js's runtime side effects (NVIDIA_API_KEY
// validation, opening the local SQLite file) — a machine that only runs
// remote.ts should need none of that.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { ChatMessage, TaskMode, ToolApprovalDecision } from "../../core/graph.js";
import type { Chat, SecurityMode } from "../../core/memory/chats.js";
import type { Goal } from "../../core/memory/goals.js";
import type { ThinkingMode } from "../../core/llm/nemotron.js";
import { listSkills, readSkill } from "../../core/skills.js";
import { listHubSkills, installHubSkill, type HubSkill } from "../../core/skillsHub.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTEXT_BAR_WIDTH = 20;
export const INPUT_PROMPT = `${chalk.cyanBright.bold("you")} ${chalk.dim("›")} `;
export const LOCAL_COMMANDS = ["/help", "/model", "/status", "/clear", "/context", "/stop", "/retry", "/compact", "/archive", "/resume", "/think", "/task", "/theme", "/permissions", "/security", "/verbose", "/memory", "/quit"];

// A lone plan_propose call gets rendered as a numbered plan, so callers need
// this shape rather than the fuller LangGraph-native PendingToolCall from
// graph.ts (deliberately not imported as a value here — see the file
// comment). Structurally identical to it and to the "calls" array the web
// API's approval_required SSE event carries.
export interface PendingToolCall {
  id: string;
  name: string;
  args: unknown;
}

export let cancelActiveInput: (() => void) | undefined;
export let transcript = "";
export function setTranscript(value: string): void { transcript = value; }
// The most recently written tool-call block (input summary + result) that
// hasn't collapsed yet — tracked as a [start, end) range in `transcript` so
// it can be spliced down to a one-line `[toolName]` the moment anything
// follows it (more text, another tool call, or the next turn's message).
// Only the very last tool block on screen stays expanded.
let danglingToolBlock: { start: number; end: number; label: string } | null = null;
export function setDanglingToolBlock(value: typeof danglingToolBlock): void { danglingToolBlock = value; }
let bannerTranscript = "";
let generationInput = "";
let generationCursor = 0;
export function getGenerationInput(): string { return generationInput; }
export function setGenerationInput(value: string, cursor: number): void { generationInput = value; generationCursor = cursor; }
const promptHistory: string[] = [];
let latestRender: { input: string; cursor: number; contextLine: string } = { input: "", cursor: 0, contextLine: "" };
let pendingRender: { input: string; cursor: number; contextLine: string } | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
export let activePrompt = INPUT_PROMPT;
export let activeModeLabel = "None";
export function setActiveModeLabel(value: string): void { activeModeLabel = value; }
export let activePermissionLabel: SecurityMode = "bypass";
export function setActivePermissionLabel(value: SecurityMode): void { activePermissionLabel = value; }
type TerminalTheme = "auto" | "light" | "dark";
let terminalTheme: TerminalTheme = "auto";
export function getTerminalTheme(): TerminalTheme { return terminalTheme; }
export function setTerminalTheme(value: TerminalTheme): void { terminalTheme = value; }
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
// while a turn is generating (armStopCommand). Returns true if the keypress
// was fully handled (including its own re-render), so the caller should
// stop processing it any further.
export async function handleMentionKeypress(
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
// calls skill_read on its own. Unmatched "@word" tokens (not a real skill
// name) are left as plain text.
export function expandSkillMentions(message: string): string {
  const names = new Set(listSkills().map((skill) => skill.name));
  const mentioned = new Set<string>();
  for (const match of message.matchAll(/(?:^|\s)@([\w-]+)/g)) {
    if (names.has(match[1])) mentioned.add(match[1]);
  }
  if (!mentioned.size) return message;
  const blocks = [...mentioned].map((name) => `<skill name="${name}">\n${readSkill(name)}\n</skill>`);
  return `${message}\n\n---\n${blocks.join("\n\n")}`;
}

export function isLightTerminal(): boolean {
  if (terminalTheme === "light") return true;
  if (terminalTheme === "dark") return false;
  // COLORFGBG conventionally stores foreground;background; a background
  // value of 15 is the usual white terminal background.
  return /(?:^|[;:])15$/.test(process.env.COLORFGBG ?? "");
}

export function uiDim(text: string): string {
  return isLightTerminal() ? chalk.gray(text) : chalk.dim(text);
}

export function uiWhite(text: string): string {
  return isLightTerminal() ? chalk.blackBright(text) : chalk.whiteBright(text);
}

export function appendTranscript(text: string): void {
  transcript += text;
}

export function stripAnsi(text: string): string {
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

export function renderScreen(input: string, cursor: number, contextLine: string): void {
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

export function flushRender(): void {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = undefined;
  }
  const next = pendingRender;
  pendingRender = undefined;
  if (next) drawScreen(next.input, next.cursor, next.contextLine);
}

export function writeLive(text: string, contextLine: string): void {
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

export function rule(): string {
  return uiDim("─".repeat(ruleWidth()));
}

export function readInput(
  contextLine: string,
  initialValue = "",
  prompt = INPUT_PROMPT,
  recordHistory = true,
): Promise<string> {
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  activePrompt = prompt;
  let value = initialValue;
  let cursor = initialValue.length;
  let historyIndex = promptHistory.length;
  renderScreen(value, cursor, contextLine);

  return new Promise((resolve) => {
    const finish = (result: string, record: boolean) => {
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      activePrompt = INPUT_PROMPT;
      cancelActiveInput = undefined;
      if (record && recordHistory && result.trim()) promptHistory.push(result);
      appendTranscript(`${prompt}${result}\n`);
      resolve(result);
    };

    const onKeypress = async (input: string, key: readline.Key) => {
      if (
        await handleMentionKeypress(
          key,
          value,
          cursor,
          (v, c) => {
            value = v;
            cursor = c;
          },
          contextLine,
        )
      )
        return;
      if (key.ctrl && key.name === "c") {
        process.emit("SIGINT");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(value, true);
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
        if (cursor > 0) cursor--;
        renderScreen(value, cursor, contextLine);
        return;
      }
      if (key.name === "right") {
        if (cursor < value.length) cursor++;
        renderScreen(value, cursor, contextLine);
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
      if (key.name === "up") {
        if (historyIndex > 0) {
          historyIndex--;
          value = promptHistory[historyIndex] ?? "";
          cursor = value.length;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "down") {
        if (historyIndex < promptHistory.length) {
          historyIndex++;
          value = promptHistory[historyIndex] ?? "";
          cursor = value.length;
          renderScreen(value, cursor, contextLine);
        }
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

// Minimal shape pickArchivedChat needs — satisfied directly by ChatRegistry
// (local mode) and by a small REST-backed adapter (remote mode).
export interface ArchivedChatSource {
  listArchived(): Chat[] | Promise<Chat[]>;
  delete(id: string): void | Promise<void>;
}

// Backs /resume: browse archived chats, invoke one (Enter — unarchives it
// and returns it as the new current chat) or delete one (Ctrl+D — purges it
// via source.delete, keeps the picker open on the remaining list). Mirrors
// the CLI's other arrow-key pickers (same keyboard/search/redraw behavior).
export async function pickArchivedChat(contextLine: string, source: ArchivedChatSource): Promise<Chat | undefined> {
  let archived = await source.listArchived();
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

    const onKeypress = async (input: string, key: readline.Key) => {
      const matches = archived.filter((chat) => chat.title.toLowerCase().includes(query.toLowerCase()));
      if (key.ctrl && key.name === "d") {
        const target = matches[selected];
        if (target) {
          await source.delete(target.id);
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

export interface NvidiaModelInfo {
  id: string;
  contextWindowTokens?: number;
}

export function pickModel(contextLine: string, models: NvidiaModelInfo[], currentModel: string): Promise<NvidiaModelInfo | undefined> {
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

export function pickPermission(contextLine: string, current: SecurityMode): Promise<SecurityMode | undefined> {
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

// Replays a chat's history into the transcript exactly as the live stream
// would have written it — used both by index.ts (after listChatMessages(graph, id))
// and remote.ts (after GET /api/chats/:id/messages), which return the same
// ChatMessage[] shape.
export function showRestoredMessages(messages: ChatMessage[], modelName: string): void {
  setTranscript("");
  setDanglingToolBlock(null);
  printBanner(modelName);
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

export const SECURITY_LABELS: Record<SecurityMode, string> = {
  bypass: "bypass (run everything)",
  accept_edit: "accept edit (confirm destructive calls)",
  manual: "manual (confirm every call)",
};

// Backs a paused tool-approval interrupt — a single yes/no for the whole
// batch, since the terminal has no per-call widget the way the web UI's
// approval block does.
//
// A lone plan_propose call (Plan task mode) gets a distinct rendering — a
// numbered plan instead of a raw args blob, and a start/discuss framing
// instead of generic approve/deny — mirroring the web UI's addApprovalBlock
// (thread.js).
export async function promptToolApproval(contextLine: string, calls: PendingToolCall[]): Promise<ToolApprovalDecision> {
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
// it happen or reopening it later.
const RESULT_MAX_CHARS = 1400;
const RESULT_MAX_LINES = 16;

// Caps length/line count so one huge result can't push everything above it
// off-screen — the full untruncated text is still what the model sees (this
// only affects what gets printed to the terminal).
export function capForDisplay(text: string): string {
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

export function collapsedToolLine(name: string): string {
  return uiDim(`[${name}]`);
}

export function collapseDanglingToolBlock(): void {
  if (!danglingToolBlock) return;
  const { start, end, label } = danglingToolBlock;
  transcript = transcript.slice(0, start) + `${collapsedToolLine(label)}\n\n` + transcript.slice(end);
  danglingToolBlock = null;
}

export function markDanglingToolBlock(start: number, label: string): void {
  danglingToolBlock = { start, end: transcript.length, label };
}

export function formatToolResult(name: string, content: string): string {
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

export function renderContextBar(usedTokens: number, maxTokens: number): string {
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

function buildBanner(modelName: string): string {
  const sourceArt = readFileSync(join(__dirname, "ascii-art.txt"), "utf-8").trimEnd();
  const art = fitAsciiArt(sourceArt, (stdout.columns || 80) - 2);
  return `${art}\n\n  ${uiDim("model")}    ${modelName}\n  ${uiDim("memory")}   MEMORY.md\n  ${uiDim("status")}   ${chalk.greenBright("ready")}\n\n${uiDim("  type a message to begin · ctrl+c to stop at any time")}\n\n`;
}

export function printBanner(modelName: string) {
  bannerTranscript = buildBanner(modelName);
  appendTranscript(bannerTranscript);
}

export function refreshBanner(modelName: string) {
  if (!bannerTranscript || !transcript.startsWith(bannerTranscript)) return;
  const oldBannerLength = bannerTranscript.length;
  const history = transcript.slice(oldBannerLength);
  transcript = "";
  printBanner(modelName);
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

// Registered once per process — each entry point (index.ts, remote.ts)
// calls initResizeHandler(getModelName) during startup with its own way of
// getting the current model name (local: config.nemotronModel; remote:
// whatever /api/status last reported).
export function initResizeHandler(getModelName: () => string): void {
  stdout.on("resize", () => {
    if (activePickerRedraw) {
      activePickerRedraw();
      return;
    }
    refreshBanner(getModelName());
    renderScreen(latestRender.input, latestRender.cursor, latestRender.contextLine);
    flushRender();
  });
}

export function printHelp() {
  appendTranscript(
    `${uiDim("  local commands")}\n  ${chalk.cyanBright("/help")}     show this help\n  ${chalk.cyanBright("/model")}    search and select an NVIDIA model\n  ${chalk.cyanBright("/status")}   show model, memory and tool status\n  ${chalk.cyanBright("/clear")}    clear the terminal and redraw the banner\n  ${chalk.cyanBright("/context")}  show context usage\n  ${chalk.cyanBright("/stop")}     stop the active generation\n  ${chalk.cyanBright("/retry")}    retry the last user message\n  ${chalk.cyanBright("/compact")}  summarize and compact session history\n  ${chalk.cyanBright("/archive")}  rename (optional), then archive the chat and start a new one\n  ${chalk.cyanBright("/resume")}   browse archived chats — Enter to resume, Ctrl+D to delete\n  ${chalk.cyanBright("/think")}    set reasoning: on, low or off\n  ${chalk.cyanBright("/task")}     set task mode: none, todo, plan or goal (goal: next message sent becomes the objective)\n  ${chalk.cyanBright("/theme")}    terminal theme: auto, light or dark\n  ${chalk.cyanBright("/permissions")} choose bypass, accept_edit or manual with ↑/↓ + Enter\n  ${chalk.cyanBright("/security")} set tool approval: bypass, accept_edit or manual\n  ${chalk.cyanBright("/verbose")}  toggle timing and token metrics\n  ${chalk.cyanBright("/memory")}   list, clear, or forget auto-accumulated observations about you\n  ${chalk.cyanBright("/export")}   [path|on|off] live-export this chat to a file, updated after every turn\n  ${chalk.cyanBright("/quit")}     stop ULTRON\n\n`,
  );
}

// Shared by /status and /task goal (bare or "status") — same one-liner
// either way so the two surfaces never drift into describing the goal
// differently.
export function goalStatusLine(goal: Goal | undefined): string {
  if (!goal || goal.status === "cleared") return "no active goal — /task goal, then send a message";
  const turns = `${goal.turnsUsed}/${goal.maxTurns} turns`;
  if (goal.status === "active") return `active (${turns}): ${goal.objective}`;
  if (goal.status === "paused") return `paused${goal.lastReason ? ` — ${goal.lastReason}` : ""} (${turns}): ${goal.objective}`;
  if (goal.status === "complete") return `✓ complete${goal.lastReason ? ` — ${goal.lastReason}` : ""}: ${goal.objective}`;
  return `${goal.status}: ${goal.objective}`;
}

export function printStatus(
  modelName: string,
  toolCount: number,
  thinkingMode: ThinkingMode,
  taskMode: TaskMode,
  verbose: boolean,
  chatId: string,
  securityMode: SecurityMode,
  goal: Goal | undefined,
) {
  appendTranscript(
    `  ${uiDim("model")}    ${modelName}\n  ${uiDim("memory")}   MEMORY.md · chat ${chatId}\n  ${uiDim("tools")}    ${toolCount} available\n  ${uiDim("think")}    ${thinkingMode}\n  ${uiDim("task")}     ${taskMode}\n  ${uiDim("security")} ${securityMode}\n  ${uiDim("goal")}     ${goalStatusLine(goal)}\n  ${uiDim("verbose")}  ${verbose ? "on" : "off"}\n  ${uiDim("status")}   ${chalk.greenBright("ready")}\n\n`,
  );
}

export function armStopCommand(abort: AbortController, contextLine: string): () => void {
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
