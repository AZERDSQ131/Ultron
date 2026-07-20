import { api } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { state } from "./store.js";
import {
  addApprovalBlock,
  addMetaLine,
  addSystemNote,
  beginToolGroup,
  addTurn,
  clearThread,
  scrollToEndIfNear,
  truncateAfterLastUserTurn,
  truncateFromLastUserTurn,
  updateTurnActions,
} from "./thread.js";
import { openArchiveDialog, openResumePanel } from "./archivePanel.js";
import { loadStatus, updateContextGauge, openModelMenu } from "./statusBar.js";
import { loadChats, selectChat, getChat, createNewChat } from "./chatList.js";
import { refreshTodos } from "./todos.js";
import { setTheme } from "./theme.js";
import { openHealthView } from "./healthView.js";

// Any tool result from either of these means the panel is stale — refresh
// it. Kept as a set so a future todo tool only needs adding here once,
// instead of touching both tool_result handlers below (streamTurn's own
// turn, and attachToRunningChat's reattachment to a background spawn_agent
// run) separately again.
const TODO_TOOL_NAMES = new Set(["todo_write", "todo_update", "plan_propose"]);

const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const thinkingBtn = document.getElementById("thinking-btn");
const thinkingBtnLabel = document.getElementById("thinking-btn-label");
const thinkingMenu = document.getElementById("thinking-menu");
const thinkingOptions = [...thinkingMenu.querySelectorAll(".thinking-option")];
const thinkingSelectSettings = document.getElementById("thinking-select-settings");
const THINKING_LABELS = { full: "Full", low: "Low", off: "Off" };
const taskBtn = document.getElementById("task-btn");
const taskBtnLabel = document.getElementById("task-btn-label");
const taskMenu = document.getElementById("task-menu");
const taskOptions = [...taskMenu.querySelectorAll(".task-option")];
const TASK_LABELS = { none: "None", todo: "To-Do", plan: "Plan", goal: "Goal" };
const securityBtn = document.getElementById("security-btn");
const securityBtnLabel = document.getElementById("security-btn-label");
const securityMenu = document.getElementById("security-menu");
const securityOptions = [...securityMenu.querySelectorAll(".security-option")];
const SECURITY_LABELS = { bypass: "Bypass", accept_edit: "Accept Edit", manual: "Manual" };
const verboseToggle = document.getElementById("verbose-toggle");
const commandMenu = document.getElementById("command-menu");

export function focusInput() {
  input.focus();
}

export function setGenerating(value) {
  state.generating = value;
  sendBtn.hidden = value;
  stopBtn.hidden = !value;
  updateTurnActions();
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

function setInputValue(text) {
  input.value = text;
  autoGrow();
}

// The full CLI command surface (see src/interfaces/cli/index.ts), replicated
// here so the web UI is a superset, not a subset, of what the CLI/Telegram
// can do — this was the biggest gap the redesign was asked to close.
export const COMMANDS = [
  { name: "/help", desc: "show available commands" },
  { name: "/status", desc: "show model, memory, tool and runtime status" },
  { name: "/context", desc: "show current context usage" },
  { name: "/stop", desc: "stop the active generation" },
  { name: "/retry", desc: "remove the last reply and regenerate it" },
  { name: "/compact", desc: "summarize old messages, keep recent context" },
  { name: "/archive", desc: "rename (optional) and archive this chat, start a new one" },
  { name: "/resume", desc: "browse archived chats — reopen or delete one" },
  { name: "/main", desc: "switch to the main conversation" },
  { name: "/delete", desc: "delete this conversation (memory preserved)" },
  { name: "/think", desc: "set reasoning: on, low or off" },
  { name: "/task", desc: "set task mode: none, todo, plan or goal" },
  { name: "/security", desc: "set tool approval: bypass, accept_edit or manual" },
  { name: "/permissions", desc: "open the tool-approval mode menu" },
  { name: "/model", desc: "open the model picker" },
  { name: "/theme", desc: "set theme: system, dark or light" },
  { name: "/verbose", desc: "toggle timing and token metrics" },
  { name: "/memory", desc: "list, clear, or forget auto-accumulated observations about you" },
  { name: "/health", desc: "open the health dashboard" },
  { name: "/export", desc: "live-export this chat to a file: [path|on|off]" },
  { name: "/clear", desc: "clear this chat view" },
  { name: "/quit", desc: "about closing this interface" },
];
const LOCAL_COMMANDS = COMMANDS.map((c) => c.name);

let menuMatches = [];
let menuIndex = -1;
let menuKind = "command";
let skills = [];
let skillsLoaded = false;

function closeCommandMenu() {
  commandMenu.hidden = true;
  commandMenu.innerHTML = "";
  menuMatches = [];
  menuIndex = -1;
  menuKind = "command";
}

function renderCommandMenu() {
  commandMenu.innerHTML = "";
  menuMatches.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = "item" + (i === menuIndex ? " active" : "");
    item.innerHTML = `<span class="name">${menuKind === "skill" ? `@${cmd.name}` : cmd.name}</span><span class="desc">${cmd.description ?? cmd.desc ?? ""}${cmd.source === "hub" ? " · hub" : ""}</span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (menuKind === "skill") acceptSkill(cmd);
      else acceptCommand(cmd);
    });
    commandMenu.appendChild(item);
  });
  commandMenu.hidden = menuMatches.length === 0;
}

function acceptCommand(cmd) {
  setInputValue(`${cmd.name} `);
  closeCommandMenu();
  input.focus();
}

function updateCommandMenu() {
  const value = input.value;
  const mention = value.match(/(?:^|\s)@([\w-]*)$/);
  if (mention && skillsLoaded) {
    const query = mention[1].toLowerCase();
    menuMatches = skills.filter((skill) => skill.name.toLowerCase().includes(query));
    menuKind = "skill";
    menuIndex = 0;
    if (menuMatches.length) renderCommandMenu(); else closeCommandMenu();
    return;
  }
  const isCommandToken = value.startsWith("/") && !/\s/.test(value);
  if (!isCommandToken) {
    closeCommandMenu();
    return;
  }
  menuMatches = COMMANDS.filter((cmd) => cmd.name.startsWith(value));
  if (menuMatches.length === 0 || (menuMatches.length === 1 && menuMatches[0].name === value)) {
    closeCommandMenu();
    return;
  }
  menuIndex = 0;
  renderCommandMenu();
}

async function acceptSkill(skill) {
  if (skill.source === "hub") {
    const result = await api.installSkill(skill.name);
    if (!result.installed) return;
  }
  const match = input.value.match(/(?:^|\s)@[\w-]*$/);
  if (!match) return;
  const start = match.index + match[0].length - (match[0].match(/@[\w-]*$/)?.[0].length ?? 0);
  input.value = `${input.value.slice(0, start)}@${skill.name} `;
  autoGrow();
  closeCommandMenu();
  input.focus();
}

async function loadSkills() {
  try {
    skills = (await api.skills()).skills;
    skillsLoaded = true;
  } catch {
    skills = [];
  }
}

input.addEventListener("input", () => {
  autoGrow();
  updateCommandMenu();
});

input.addEventListener("keydown", (e) => {
  if (!commandMenu.hidden && menuMatches.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menuIndex = (menuIndex + 1) % menuMatches.length;
      renderCommandMenu();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      menuIndex = (menuIndex - 1 + menuMatches.length) % menuMatches.length;
      renderCommandMenu();
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      if (menuKind === "skill") acceptSkill(menuMatches[menuIndex]);
      else acceptCommand(menuMatches[menuIndex]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeCommandMenu();
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

input.addEventListener("blur", () => {
  // Deferred so a menu-item mousedown can still register before it disappears.
  setTimeout(closeCommandMenu, 120);
});

function closeThinkingMenu() {
  thinkingMenu.hidden = true;
  thinkingBtn.setAttribute("aria-expanded", "false");
}

function openThinkingMenu() {
  thinkingMenu.hidden = false;
  thinkingBtn.setAttribute("aria-expanded", "true");
  (thinkingOptions.find((opt) => opt.dataset.value === state.thinkingMode) ?? thinkingOptions[0])?.focus();
}

// Single source of truth for the reasoning mode — keeps the composer
// button, its popover menu, and the settings panel's mirrored <select> all
// in sync, and is what /think and the palette-driven command both call
// into instead of poking each control separately.
export function setThinkingMode(mode) {
  state.thinkingMode = mode;
  thinkingBtn.dataset.mode = mode;
  thinkingBtnLabel.textContent = THINKING_LABELS[mode] ?? mode;
  thinkingSelectSettings.value = mode;
  for (const opt of thinkingOptions) {
    const active = opt.dataset.value === mode;
    opt.classList.toggle("active", active);
    opt.setAttribute("aria-selected", String(active));
  }
}

thinkingBtn.addEventListener("click", () => {
  thinkingMenu.hidden ? openThinkingMenu() : closeThinkingMenu();
});

thinkingMenu.addEventListener("keydown", (e) => {
  const currentIndex = thinkingOptions.indexOf(document.activeElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    thinkingOptions[(currentIndex + 1) % thinkingOptions.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    thinkingOptions[(currentIndex - 1 + thinkingOptions.length) % thinkingOptions.length]?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeThinkingMenu();
    thinkingBtn.focus();
  }
});

for (const opt of thinkingOptions) {
  opt.addEventListener("click", () => {
    setThinkingMode(opt.dataset.value);
    closeThinkingMenu();
    thinkingBtn.focus();
  });
}

document.addEventListener("click", (e) => {
  // contains(), not === — a click on the icon/label spans inside the
  // button is a different e.target than thinkingBtn itself, so the old
  // strict-equality check treated every click on the button's own text as
  // "outside" and closed the menu the instant it opened.
  if (!thinkingMenu.hidden && !thinkingMenu.contains(e.target) && !thinkingBtn.contains(e.target)) closeThinkingMenu();
});

thinkingSelectSettings.addEventListener("change", () => setThinkingMode(thinkingSelectSettings.value));

setThinkingMode(state.thinkingMode);

function closeTaskMenu() {
  taskMenu.hidden = true;
  taskBtn.setAttribute("aria-expanded", "false");
}

function openTaskMenu() {
  taskMenu.hidden = false;
  taskBtn.setAttribute("aria-expanded", "true");
  (taskOptions.find((opt) => opt.dataset.value === state.taskMode) ?? taskOptions[0])?.focus();
}

// Client-side only, same as reasoning mode — it's a per-turn instruction
// (see taskModeDirective in graph.ts), not a chat-level setting worth
// persisting server-side.
export function setTaskMode(mode) {
  state.taskMode = mode;
  taskBtn.dataset.mode = mode;
  taskBtnLabel.textContent = TASK_LABELS[mode] ?? mode;
  for (const opt of taskOptions) {
    const active = opt.dataset.value === mode;
    opt.classList.toggle("active", active);
    opt.setAttribute("aria-selected", String(active));
  }

  // Composer border and the left-side label are the "am I in To-Do/Plan
  // mode" indicator that doesn't require opening the task menu to check —
  // color carries the mode the same way the security button's icon carries
  // risk level (see .security-btn-icon in style.css).
  composer.dataset.task = mode;
}

taskBtn.addEventListener("click", () => {
  taskMenu.hidden ? openTaskMenu() : closeTaskMenu();
});

taskMenu.addEventListener("keydown", (e) => {
  const currentIndex = taskOptions.indexOf(document.activeElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    taskOptions[(currentIndex + 1) % taskOptions.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    taskOptions[(currentIndex - 1 + taskOptions.length) % taskOptions.length]?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeTaskMenu();
    taskBtn.focus();
  }
});

for (const opt of taskOptions) {
  opt.addEventListener("click", () => {
    setTaskMode(opt.dataset.value);
    closeTaskMenu();
    taskBtn.focus();
  });
}

document.addEventListener("click", (e) => {
  if (!taskMenu.hidden && !taskMenu.contains(e.target) && !taskBtn.contains(e.target)) closeTaskMenu();
});

setTaskMode(state.taskMode);

function closeSecurityMenu() {
  securityMenu.hidden = true;
  securityBtn.setAttribute("aria-expanded", "false");
}

export function openSecurityMenu() {
  securityMenu.hidden = false;
  securityBtn.setAttribute("aria-expanded", "true");
  (securityOptions.find((opt) => opt.dataset.value === state.securityMode) ?? securityOptions[0])?.focus();
}

// Reflects a chat's mode in the UI without writing it back to the server —
// used when switching chats, since the mode being displayed already came
// from that chat's own record (see chatList.js's selectChat).
export function syncSecurityMode(mode) {
  state.securityMode = mode;
  securityBtn.dataset.mode = mode;
  securityBtnLabel.textContent = SECURITY_LABELS[mode] ?? mode;
  for (const opt of securityOptions) {
    const active = opt.dataset.value === mode;
    opt.classList.toggle("active", active);
    opt.setAttribute("aria-selected", String(active));
  }
}

// User-driven change — updates the UI and persists it against the active
// chat via PATCH /api/chats/:id/security (handleSetSecurity in server.ts),
// which is what toolsNode reads on the next tool call (see graph.ts).
async function setSecurityMode(mode) {
  syncSecurityMode(mode);
  if (!state.activeChatId) return;
  await api.setSecurityMode(state.activeChatId, mode);
  const chat = state.chatsCache.find((c) => c.id === state.activeChatId);
  if (chat) chat.securityMode = mode;
}

securityBtn.addEventListener("click", () => {
  securityMenu.hidden ? openSecurityMenu() : closeSecurityMenu();
});

securityMenu.addEventListener("keydown", (e) => {
  const currentIndex = securityOptions.indexOf(document.activeElement);
  if (e.key === "ArrowDown") {
    e.preventDefault();
    securityOptions[(currentIndex + 1) % securityOptions.length]?.focus();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    securityOptions[(currentIndex - 1 + securityOptions.length) % securityOptions.length]?.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSecurityMenu();
    securityBtn.focus();
  }
});

for (const opt of securityOptions) {
  opt.addEventListener("click", () => {
    setSecurityMode(opt.dataset.value);
    closeSecurityMenu();
    securityBtn.focus();
  });
}

document.addEventListener("click", (e) => {
  if (!securityMenu.hidden && !securityMenu.contains(e.target) && !securityBtn.contains(e.target)) closeSecurityMenu();
});

syncSecurityMode(state.securityMode);
verboseToggle.addEventListener("change", () => {
  state.verbose = verboseToggle.checked;
});

export async function streamTurn(body) {
  setGenerating(true);
  let assistantBody = null;
  let assistantText = "";
  let cursorEl = null;
  let toolGroup = null;

  const finishAssistant = () => {
    if (cursorEl) cursorEl.remove();
    cursorEl = null;
  };
  const finishTurn = () => {
    finishAssistant();
    toolGroup?.finish();
    toolGroup = null;
  };

  // Consumes one SSE response to completion. Recurses into a fresh
  // /api/approve request when the stream ends on "approval_required" (see
  // toolsNode's interrupt() call in graph.ts) instead of a terminal event —
  // the assistant bubble/cursor state above stays shared across that
  // boundary so a reply that continues after the tool runs looks like one
  // uninterrupted turn, not two.
  const pump = async (res) => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "request failed" }));
      addSystemNote(`[ultron] ${err.error ?? "request failed"}`, true);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          if (!assistantBody) {
            assistantBody = addTurn("assistant");
            cursorEl = document.createElement("span");
            cursorEl.className = "cursor";
          }
          assistantText += data.delta;
          assistantBody.dataset.raw = assistantText;
          assistantBody.innerHTML = renderMarkdown(assistantText);
          if (cursorEl) assistantBody.appendChild(cursorEl);
          scrollToEndIfNear();
        } else if (eventName === "tool_call") {
          finishAssistant();
          if (!toolGroup) toolGroup = beginToolGroup(assistantBody);
          const pre = toolGroup.addCall(data.name, data.summary);
          pre.dataset.name = data.name;
        } else if (eventName === "tool_result") {
          const blocks = [...document.querySelectorAll(".tool-block pre")];
          const match = [...blocks].reverse().find((p) => p.dataset.name === data.name && p.textContent === "…");
          if (match) match.textContent = data.content;
          if (TODO_TOOL_NAMES.has(data.name)) refreshTodos();
        } else if (eventName === "approval_required") {
          finishAssistant();
          const decisions = await addApprovalBlock(data.calls);
          await pump(
            await fetch("/api/approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: body.chatId, thinking: body.thinking, taskMode: body.taskMode, decisions }),
            }),
          );
        } else if (eventName === "done") {
          finishTurn();
          updateContextGauge(data.contextTokens, data.maxTokens);
          if (state.verbose) {
            addMetaLine(data.stats);
          }
        } else if (eventName === "goal") {
          addSystemNote(`[ultron] goal ${data.status}${data.reason ? ` — ${data.reason}` : ""}`);
          loadStatus();
        } else if (eventName === "aborted") {
          finishTurn();
          addSystemNote("[ultron] generation stopped.");
        } else if (eventName === "error") {
          finishTurn();
          addSystemNote(`[ultron] error: ${data.message}`, true);
        }
      }
    }
  };

  try {
    await pump(
      await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } catch (err) {
    addSystemNote(`[ultron] connection error: ${err.message}`, true);
  } finally {
    finishTurn();
    setGenerating(false);
    // Refreshes the sidebar so an auto-derived title (first message of a
    // "New chat") and the recency ordering pick up this turn.
    loadChats();
  }
}

// Joins a chat that's currently a spawn_agent background execution (see
// runs.ts/tools/agents.ts) via GET /api/chats/:id/stream instead of only
// ever seeing it once it's finished — same event vocabulary as a normal
// turn (text/tool_call/tool_result/done/aborted/error), so it reuses the
// same rendering calls, but there's no POST body / turn stats here, so it's
// kept separate from streamTurn's pump rather than forced to share it.
export async function attachToRunningChat(chatId) {
  setGenerating(true);
  let assistantBody = null;
  let assistantText = "";
  let cursorEl = null;
  let toolGroup = null;
  const finishAssistant = () => {
    if (cursorEl) cursorEl.remove();
    cursorEl = null;
  };
  const finishTurn = () => {
    finishAssistant();
    toolGroup?.finish();
    toolGroup = null;
  };
  // If the user switches to a different chat before this stream ends,
  // stop rendering into it — the DOM it was writing to may belong to
  // whatever chat is showing now.
  const stillViewing = () => state.activeChatId === chatId;

  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/stream`);
    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!stillViewing()) {
        await reader.cancel();
        break;
      }
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

        if (eventName === "not_running" || eventName === "attached") {
          continue;
        } else if (eventName === "text") {
          if (!assistantBody) {
            assistantBody = addTurn("assistant");
            cursorEl = document.createElement("span");
            cursorEl.className = "cursor";
          }
          assistantText += data.delta;
          assistantBody.dataset.raw = assistantText;
          assistantBody.innerHTML = renderMarkdown(assistantText);
          if (cursorEl) assistantBody.appendChild(cursorEl);
          scrollToEndIfNear();
        } else if (eventName === "tool_call") {
          finishAssistant();
          if (!toolGroup) toolGroup = beginToolGroup(assistantBody);
          const pre = toolGroup.addCall(data.name, data.summary);
          pre.dataset.name = data.name;
        } else if (eventName === "tool_result") {
          const blocks = [...document.querySelectorAll(".tool-block pre")];
          const match = [...blocks].reverse().find((p) => p.dataset.name === data.name && p.textContent === "…");
          if (match) match.textContent = data.content;
          if (TODO_TOOL_NAMES.has(data.name)) refreshTodos();
        } else if (eventName === "aborted") {
          finishTurn();
          addSystemNote("[ultron] generation stopped.");
        } else if (eventName === "error") {
          finishTurn();
          addSystemNote(`[ultron] error: ${data.message}`, true);
        } else if (eventName === "done") {
          finishTurn();
        }
      }
    }
  } catch (err) {
    if (stillViewing()) addSystemNote(`[ultron] connection error: ${err.message}`, true);
  } finally {
    finishTurn();
    if (stillViewing()) setGenerating(false);
    loadChats();
  }
}

export async function regenerateLast() {
  if (state.generating) return;
  truncateAfterLastUserTurn();
  await streamTurn({ chatId: state.activeChatId, retry: true, thinking: state.thinkingMode, taskMode: state.taskMode });
}

export async function editLast() {
  if (state.generating) return;
  const res = await api.edit(state.activeChatId);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    addSystemNote(`[ultron] ${err.error ?? "nothing to edit yet"}`, true);
    return;
  }
  const { content } = await res.json();
  truncateFromLastUserTurn();
  setInputValue(content);
  input.focus();
  input.setSelectionRange(content.length, content.length);
}

async function runCommand(raw) {
  const [command, ...rest] = raw.trim().split(/\s+/);
  const arg = rest.join(" ");

  if (command === "/help") {
    addSystemNote(
      "[ultron] commands: /status · /context · /stop · /retry · /compact · /archive · /resume · " +
        "/main · /delete · /think on|low|off · /task none|todo|plan|goal · /security bypass|accept_edit|manual · " +
        "/permissions · /model · /theme system|dark|light · /verbose on|off · /memory [clear|forget <id>] · " +
        "/health · /export [path|on|off] · /clear · /quit",
    );
    return;
  }

  if (command === "/status") {
    try {
      const data = await api.status(state.activeChatId);
      addSystemNote(
        `[ultron] model ${data.model} · chat ${state.activeChatId} · ${data.toolCount} tools · ` +
          `think ${state.thinkingMode} · verbose ${state.verbose ? "on" : "off"} · status ready`,
      );
    } catch {
      addSystemNote("[ultron] could not reach the server.", true);
    }
    return;
  }

  if (command === "/context") {
    try {
      const data = await api.status(state.activeChatId);
      updateContextGauge(data.contextTokens, data.maxTokens);
      const pct = Math.round((data.contextTokens / data.maxTokens) * 100);
      addSystemNote(`[ultron] context: ${data.contextTokens.toLocaleString()} / ${data.maxTokens.toLocaleString()} tokens (${pct}%)`);
    } catch {
      addSystemNote("[ultron] could not reach the server.", true);
    }
    return;
  }

  if (command === "/clear") {
    clearThread();
    return;
  }

  if (command === "/think") {
    const mode = arg.toLowerCase();
    if (!mode) {
      addSystemNote(`[ultron] reasoning mode: ${state.thinkingMode} (use /think on, /think low or /think off).`);
      return;
    }
    const next = mode === "on" || mode === "full" ? "full" : mode === "low" ? "low" : mode === "off" ? "off" : undefined;
    if (!next) {
      addSystemNote("[ultron] use /think on, /think low or /think off.", true);
      return;
    }
    setThinkingMode(next);
    addSystemNote(`[ultron] reasoning mode set to ${next}.`);
    return;
  }

  if (command === "/task") {
    const mode = arg.toLowerCase();
    if (!mode) {
      addSystemNote(`[ultron] task mode: ${state.taskMode} (use /task none|todo|plan|goal).`);
      return;
    }
    if (!["none", "todo", "plan", "goal"].includes(mode)) {
      addSystemNote("[ultron] use /task none, /task todo, /task plan or /task goal.", true);
      return;
    }
    setTaskMode(mode);
    addSystemNote(`[ultron] task mode set to ${mode}.`);
    return;
  }

  if (command === "/verbose") {
    const mode = arg.toLowerCase();
    if (!mode) {
      addSystemNote(`[ultron] verbose is ${state.verbose ? "on" : "off"} (use /verbose on or /verbose off).`);
      return;
    }
    if (mode === "on" || mode === "true") {
      state.verbose = true;
      verboseToggle.checked = true;
      addSystemNote("[ultron] verbose on.");
    } else if (mode === "off" || mode === "false") {
      state.verbose = false;
      verboseToggle.checked = false;
      addSystemNote("[ultron] verbose off.");
    } else {
      addSystemNote("[ultron] use /verbose on or /verbose off.", true);
    }
    return;
  }

  if (command === "/quit") {
    addSystemNote(
      "[ultron] this is a persistent web session — the server keeps running for next time. " +
        "Close this tab to stop using it now.",
    );
    return;
  }

  if (command === "/compact") {
    const data = await api.compact(state.activeChatId);
    if (data.compacted) await selectChat(state.activeChatId);
    addSystemNote(
      data.compacted
        ? `[ultron] compacted ${data.before} messages into ${data.after} context messages.`
        : "[ultron] not enough history to compact yet.",
    );
    return;
  }

  if (command === "/retry") {
    await regenerateLast();
    return;
  }

  if (command === "/stop") {
    await api.stop(state.activeChatId);
    return;
  }

  if (command === "/archive") {
    openArchiveDialog();
    return;
  }

  if (command === "/resume") {
    await openResumePanel();
    return;
  }

  if (command === "/main") {
    const data = await api.main();
    await loadChats();
    await selectChat(data.chat.id);
    return;
  }

  if (command === "/delete") {
    const chat = getChat(state.activeChatId);
    if (!chat) return;
    if (!confirm(`Delete "${chat.title}"? This removes its full history.`)) return;
    await api.deleteChat(chat.id);
    await loadChats();
    if (state.chatsCache.length > 0) await selectChat(state.chatsCache[0].id);
    else await createNewChat();
    return;
  }

  if (command === "/security" || command === "/permissions") {
    const mode = arg.toLowerCase();
    if (!mode) {
      openSecurityMenu();
      return;
    }
    if (!["bypass", "accept_edit", "manual"].includes(mode)) {
      addSystemNote("[ultron] use /security bypass, /security accept_edit or /security manual.", true);
      return;
    }
    syncSecurityMode(mode);
    if (state.activeChatId) {
      await api.setSecurityMode(state.activeChatId, mode);
      const chat = getChat(state.activeChatId);
      if (chat) chat.securityMode = mode;
    }
    addSystemNote(`[ultron] tool approval mode set to ${mode}.`);
    return;
  }

  if (command === "/model") {
    openModelMenu();
    return;
  }

  if (command === "/theme") {
    const mode = arg.toLowerCase();
    if (!mode) {
      addSystemNote("[ultron] use /theme system, /theme dark or /theme light.");
      return;
    }
    if (!["system", "dark", "light"].includes(mode)) {
      addSystemNote("[ultron] use /theme system, /theme dark or /theme light.", true);
      return;
    }
    setTheme(mode);
    addSystemNote(`[ultron] theme set to ${mode}.`);
    return;
  }

  if (command === "/health") {
    openHealthView();
    return;
  }

  if (command === "/export") {
    if (!state.activeChatId) return;
    const value = arg.trim();
    if (!value) {
      const data = await api.getExport(state.activeChatId);
      addSystemNote(
        data.path
          ? `[ultron] live export: ${data.path} (updates after every turn) — /export off to stop.`
          : "[ultron] no live export active for this chat — /export [path] to start, /export off to stop.",
      );
      return;
    }
    if (value.toLowerCase() === "off") {
      await api.stopExport(state.activeChatId);
      addSystemNote("[ultron] live export stopped (file left as-is).");
      return;
    }
    const data = await api.setExport(state.activeChatId, value.toLowerCase() === "on" ? undefined : value);
    addSystemNote(`[ultron] live export started: ${data.path} (updates after every turn).`);
    return;
  }

  if (command === "/memory") {
    const sub = arg.trim().toLowerCase();
    if (!sub) {
      const data = await api.memoryList();
      if (!data.observations.length) {
        addSystemNote("[ultron] no observations accumulated yet.");
        return;
      }
      const lines = data.observations
        .slice(0, 30)
        .map((o) => `#${o.id} (${o.category}) ${o.content}`)
        .join("\n");
      addSystemNote(`[ultron] ${data.count} observation(s) accumulated automatically — /memory clear or /memory forget <id>\n${lines}`);
      return;
    }
    if (sub === "clear") {
      await api.memoryClear();
      addSystemNote("[ultron] all accumulated observations cleared.");
      return;
    }
    if (sub.startsWith("forget ")) {
      const id = sub.slice("forget ".length).trim();
      await api.memoryForget(id);
      addSystemNote(`[ultron] observation #${id} forgotten (if it existed).`);
      return;
    }
    addSystemNote("[ultron] use /memory, /memory clear or /memory forget <id>.", true);
    return;
  }

  addSystemNote(`[ultron] unknown command: ${command} — try /help`, true);
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.generating) return;
  const text = input.value.trim();
  if (!text) return;
  setInputValue("");
  closeCommandMenu();

  if (text.startsWith("/") && LOCAL_COMMANDS.includes(text.split(/\s+/)[0])) {
    runCommand(text);
    return;
  }

  addTurn("user").textContent = text;
  streamTurn({ chatId: state.activeChatId, text, thinking: state.thinkingMode, taskMode: state.taskMode });
});

stopBtn.addEventListener("click", async () => {
  await api.stop(state.activeChatId);
});

// Used by the command palette (Cmd/Ctrl+K) when a slash command is picked
// from search results — same effect as typing it and hitting Tab.
export function prefillCommand(name) {
  setInputValue(`${name} `);
  input.focus();
}

export function initComposer() {
  loadStatus();
  loadSkills();
}
