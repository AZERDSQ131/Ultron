import { api } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { state } from "./store.js";
import {
  addApprovalBlock,
  addMetaLine,
  addSystemNote,
  addToolBlock,
  addTurn,
  clearThread,
  scrollToEnd,
  truncateAfterLastUserTurn,
  truncateFromLastUserTurn,
  updateTurnActions,
} from "./thread.js";
import { loadStatus, updateContextGauge } from "./statusBar.js";
import { loadChats, selectChat } from "./chatList.js";
import { refreshTodos } from "./todos.js";

// Any tool result from either of these means the panel is stale — refresh
// it. Kept as a set so a future todo tool only needs adding here once,
// instead of touching both tool_result handlers below (streamTurn's own
// turn, and attachToRunningChat's reattachment to a background spawn_agent
// run) separately again.
const TODO_TOOL_NAMES = new Set(["todo_write", "todo_update"]);

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
const TASK_LABELS = { none: "None", todo: "To-Do", plan: "Plan" };
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

export const COMMANDS = [
  { name: "/help", desc: "show available commands" },
  { name: "/status", desc: "show model, memory, tool and runtime status" },
  { name: "/context", desc: "show current context usage" },
  { name: "/stop", desc: "stop the active generation" },
  { name: "/retry", desc: "remove the last reply and regenerate it" },
  { name: "/compact", desc: "summarize old messages, keep recent context" },
  { name: "/archive", desc: "save this session to a text file" },
  { name: "/resume", desc: "restore a previously archived session" },
  { name: "/think", desc: "set reasoning: on, low or off" },
  { name: "/verbose", desc: "toggle timing and token metrics" },
  { name: "/clear", desc: "clear this chat view" },
  { name: "/quit", desc: "about closing this interface" },
];
const LOCAL_COMMANDS = COMMANDS.map((c) => c.name);

let menuMatches = [];
let menuIndex = -1;

function closeCommandMenu() {
  commandMenu.hidden = true;
  commandMenu.innerHTML = "";
  menuMatches = [];
  menuIndex = -1;
}

function renderCommandMenu() {
  commandMenu.innerHTML = "";
  menuMatches.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = "item" + (i === menuIndex ? " active" : "");
    item.innerHTML = `<span class="name">${cmd.name}</span><span class="desc">${cmd.desc}</span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptCommand(cmd);
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
      acceptCommand(menuMatches[menuIndex]);
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

function openSecurityMenu() {
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

  const finishAssistant = () => {
    if (cursorEl) cursorEl.remove();
    cursorEl = null;
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
          scrollToEnd();
        } else if (eventName === "tool_call") {
          finishAssistant();
          const pre = addToolBlock(data.name, data.summary);
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
          finishAssistant();
          updateContextGauge(data.contextTokens, data.maxTokens);
          if (state.verbose) {
            addMetaLine(`⏱ ${data.elapsedSeconds.toFixed(1)}s   ${data.generatedTokens.toLocaleString()} tokens`);
          }
        } else if (eventName === "aborted") {
          finishAssistant();
          addSystemNote("[ultron] generation stopped.");
        } else if (eventName === "error") {
          finishAssistant();
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
    finishAssistant();
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
  const finishAssistant = () => {
    if (cursorEl) cursorEl.remove();
    cursorEl = null;
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
          scrollToEnd();
        } else if (eventName === "tool_call") {
          finishAssistant();
          const pre = addToolBlock(data.name, data.summary);
          pre.dataset.name = data.name;
        } else if (eventName === "tool_result") {
          const blocks = [...document.querySelectorAll(".tool-block pre")];
          const match = [...blocks].reverse().find((p) => p.dataset.name === data.name && p.textContent === "…");
          if (match) match.textContent = data.content;
          if (TODO_TOOL_NAMES.has(data.name)) refreshTodos();
        } else if (eventName === "aborted") {
          finishAssistant();
          addSystemNote("[ultron] generation stopped.");
        } else if (eventName === "error") {
          finishAssistant();
          addSystemNote(`[ultron] error: ${data.message}`, true);
        } else if (eventName === "done") {
          finishAssistant();
        }
      }
    }
  } catch (err) {
    if (stillViewing()) addSystemNote(`[ultron] connection error: ${err.message}`, true);
  } finally {
    finishAssistant();
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
      "[ultron] commands: /status · /context · /stop · /retry · /compact · " +
        "/archive [title] · /resume <path> · /think on|low|off · /verbose on|off · /clear · /quit",
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
    const data = await api.archive(state.activeChatId, arg || undefined);
    addSystemNote(
      data.path
        ? `[ultron] chat "${data.title}" archived to ${data.path}`
        : `[ultron] ${data.error ?? "archive failed"}`,
    );
    return;
  }

  if (command === "/resume") {
    if (!arg) {
      addSystemNote("[ultron] usage: /resume <archive-path>", true);
      return;
    }
    const res = await api.resume(state.activeChatId, arg);
    const data = await res.json();
    if (res.ok) await selectChat(state.activeChatId);
    addSystemNote(
      res.ok ? `[ultron] resumed ${data.count} messages from ${arg}` : `[ultron] ${data.error ?? "resume failed"}`,
      !res.ok,
    );
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
}
