import { api } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { state } from "./store.js";
import {
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

const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const thinkingSelect = document.getElementById("thinking-mode");
const thinkingSelectSettings = document.getElementById("thinking-select-settings");
const verboseToggle = document.getElementById("verbose-toggle");
const commandMenu = document.getElementById("command-menu");

export function focusInput() {
  input.focus();
}

function setGenerating(value) {
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

thinkingSelect.addEventListener("change", () => {
  state.thinkingMode = thinkingSelect.value;
  thinkingSelectSettings.value = thinkingSelect.value;
});
thinkingSelectSettings.addEventListener("change", () => {
  state.thinkingMode = thinkingSelectSettings.value;
  thinkingSelect.value = thinkingSelectSettings.value;
});
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

  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

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

export async function regenerateLast() {
  if (state.generating) return;
  truncateAfterLastUserTurn();
  await streamTurn({ chatId: state.activeChatId, retry: true, thinking: state.thinkingMode });
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
          `think ${thinkingSelect.value} · verbose ${state.verbose ? "on" : "off"} · status ready`,
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
      addSystemNote(`[ultron] reasoning mode: ${thinkingSelect.value} (use /think on, /think low or /think off).`);
      return;
    }
    const next = mode === "on" || mode === "full" ? "full" : mode === "low" ? "low" : mode === "off" ? "off" : undefined;
    if (!next) {
      addSystemNote("[ultron] use /think on, /think low or /think off.", true);
      return;
    }
    thinkingSelect.value = next;
    thinkingSelectSettings.value = next;
    state.thinkingMode = next;
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
  streamTurn({ chatId: state.activeChatId, text, thinking: state.thinkingMode });
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
