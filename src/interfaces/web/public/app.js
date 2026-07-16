const thread = document.getElementById("thread");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const thinkingSelect = document.getElementById("thinking-mode");
const modelLabel = document.getElementById("model-label");
const contextLabel = document.getElementById("context-label");
const contextFill = document.getElementById("context-fill");
const commandMenu = document.getElementById("command-menu");
const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const chatListEl = document.getElementById("chat-list");
const newChatBtn = document.getElementById("new-chat-btn");

let generating = false;
let verbose = false;
let activeChatId = null;
let chatsCache = [];

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline markdown: links, `code`, **bold**, *italic*. Used both standalone
// (list items, table cells, headings) and as the leaf step of renderMarkdown.
function renderInline(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return html;
}

// Block-level markdown for assistant replies: headings, fenced code blocks,
// GFM tables, lists, blockquotes, rules, paragraphs. Re-run on the full
// accumulated text on every streamed chunk (see streamTurn), so a construct
// left open mid-stream (e.g. an unclosed code fence) just renders as far as
// it's gotten and corrects itself once the closing marker arrives.
function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line ?? "");
  const splitRow = (line) => {
    let row = line.trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|")) row = row.slice(0, -1);
    return row.split("|").map((cell) => cell.trim());
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(`<pre class="code-block"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push("<hr>");
      i++;
      continue;
    }

    if (line.includes("|") && isTableSep(lines[i + 1])) {
      const headerCells = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      blocks.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(`<blockquote>${quoteLines.map((l) => renderInline(l)).join("<br>")}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ""));
        i++;
      }
      blocks.push(`<ul>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(`<ol>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`);
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !(lines[i].includes("|") && isTableSep(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${paraLines.map((l) => renderInline(l)).join("<br>")}</p>`);
  }

  return blocks.join("");
}

function scrollToEnd() {
  thread.scrollTop = thread.scrollHeight;
}

function addSystemNote(text, isError = false) {
  const el = document.createElement("div");
  el.className = "system-note" + (isError ? " error" : "");
  el.textContent = text;
  thread.appendChild(el);
  scrollToEnd();
  return el;
}

function addTurn(role) {
  const turn = document.createElement("div");
  turn.className = `turn ${role}`;
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = role === "user" ? "you" : "ultron";
  const body = document.createElement("div");
  body.className = "body";
  turn.appendChild(label);
  turn.appendChild(body);
  thread.appendChild(turn);
  scrollToEnd();
  return body;
}

function addMetaLine(text) {
  const el = document.createElement("div");
  el.className = "meta-line";
  el.textContent = text;
  thread.appendChild(el);
  scrollToEnd();
}

function addToolBlock(name, summary) {
  const details = document.createElement("details");
  details.className = "tool-block";
  const s = document.createElement("summary");
  s.innerHTML = `<span class="tool-name">[${escapeHtml(name)}]</span> ${escapeHtml(summary)}`;
  const pre = document.createElement("pre");
  pre.textContent = "…";
  details.appendChild(s);
  details.appendChild(pre);
  thread.appendChild(details);
  scrollToEnd();
  return pre;
}

function setGenerating(state) {
  generating = state;
  sendBtn.hidden = state;
  stopBtn.hidden = !state;
  // Deliberately not disabling the textarea: the user should be able to
  // keep composing their next message while ULTRON is still replying.
  // The submit handler itself still blocks sending until generation ends.
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}

const COMMANDS = [
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
  input.value = `${cmd.name} `;
  autoGrow();
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

function updateContextGauge(usedTokens, maxTokens) {
  const ratio = Math.min(usedTokens / maxTokens, 1);
  contextFill.style.width = `${Math.round(ratio * 100)}%`;
  contextFill.classList.toggle("warn", ratio >= 0.5 && ratio < 0.8);
  contextFill.classList.toggle("hot", ratio >= 0.8);
  const maxLabel = maxTokens >= 1_000_000 ? `${maxTokens / 1_000_000}M` : `${Math.round(maxTokens / 1000)}k`;
  contextLabel.textContent = `${usedTokens.toLocaleString()} / ${maxLabel} tokens`;
}

async function loadStatus() {
  try {
    const res = await fetch(`/api/status?chatId=${encodeURIComponent(activeChatId ?? "")}`);
    const data = await res.json();
    modelLabel.textContent = data.model;
    updateContextGauge(data.contextTokens, data.maxTokens);
  } catch {
    modelLabel.textContent = "offline";
  }
}

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function renderChatList() {
  chatListEl.innerHTML = "";
  chatsCache.forEach((chat) => {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === activeChatId ? " active" : "");

    const title = document.createElement("div");
    title.className = "chat-title";
    title.textContent = chat.title;
    title.title = `${chat.title} · ${timeAgo(chat.updatedAt)} ago`;

    const actions = document.createElement("div");
    actions.className = "chat-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.textContent = "✎";
    renameBtn.title = "Rename";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRenameChat(chat, title);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "🗑";
    deleteBtn.title = "Delete";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(chat);
    });

    actions.append(renameBtn, deleteBtn);
    item.append(title, actions);
    item.addEventListener("click", () => {
      if (chat.id !== activeChatId) selectChat(chat.id);
    });
    chatListEl.appendChild(item);
  });
}

function startRenameChat(chat, titleEl) {
  const editor = document.createElement("input");
  editor.className = "chat-title-input";
  editor.value = chat.title;
  titleEl.replaceWith(editor);
  editor.focus();
  editor.select();

  let settled = false;
  const commit = async () => {
    if (settled) return;
    settled = true;
    const value = editor.value.trim();
    if (value && value !== chat.title) {
      await fetch(`/api/chats/${encodeURIComponent(chat.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: value }),
      });
    }
    loadChats();
  };

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editor.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      settled = true;
      loadChats();
    }
  });
  editor.addEventListener("blur", commit);
}

async function deleteChat(chat) {
  if (!confirm(`Delete "${chat.title}"? This removes its full history.`)) return;
  await fetch(`/api/chats/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
  await loadChats();
  if (chat.id === activeChatId) {
    if (chatsCache.length > 0) await selectChat(chatsCache[0].id);
    else await createNewChat();
  }
}

async function createNewChat() {
  const res = await fetch("/api/chats", { method: "POST" });
  const data = await res.json();
  await loadChats();
  await selectChat(data.chat.id);
}

async function loadChats() {
  const res = await fetch("/api/chats");
  const data = await res.json();
  chatsCache = data.chats;
  renderChatList();
}

async function selectChat(id) {
  activeChatId = id;
  closeCommandMenu();
  renderChatList();
  thread.innerHTML = "";
  await loadStatus();
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(id)}/messages`);
    const data = await res.json();
    for (const message of data.messages) {
      const body = addTurn(message.role === "human" ? "user" : "assistant");
      if (message.role === "human") body.textContent = message.content;
      else body.innerHTML = renderMarkdown(message.content);
    }
  } catch {
    addSystemNote("[ultron] could not load chat history.", true);
  }
  if (window.innerWidth <= 860) sidebar.classList.add("collapsed");
  input.focus();
}

newChatBtn.addEventListener("click", () => createNewChat());
sidebarToggle.addEventListener("click", () => sidebar.classList.toggle("collapsed"));

async function streamTurn(body) {
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
          if (verbose) {
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
      const res = await fetch(`/api/status?chatId=${encodeURIComponent(activeChatId ?? "")}`);
      const data = await res.json();
      addSystemNote(
        `[ultron] model ${data.model} · chat ${activeChatId} · ${data.toolCount} tools · ` +
          `think ${thinkingSelect.value} · verbose ${verbose ? "on" : "off"} · status ready`,
      );
    } catch {
      addSystemNote("[ultron] could not reach the server.", true);
    }
    return;
  }

  if (command === "/context") {
    try {
      const res = await fetch(`/api/status?chatId=${encodeURIComponent(activeChatId ?? "")}`);
      const data = await res.json();
      updateContextGauge(data.contextTokens, data.maxTokens);
      const pct = Math.round((data.contextTokens / data.maxTokens) * 100);
      addSystemNote(`[ultron] context: ${data.contextTokens.toLocaleString()} / ${data.maxTokens.toLocaleString()} tokens (${pct}%)`);
    } catch {
      addSystemNote("[ultron] could not reach the server.", true);
    }
    return;
  }

  if (command === "/clear") {
    thread.innerHTML = "";
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
    addSystemNote(`[ultron] reasoning mode set to ${next}.`);
    return;
  }

  if (command === "/verbose") {
    const mode = arg.toLowerCase();
    if (!mode) {
      addSystemNote(`[ultron] verbose is ${verbose ? "on" : "off"} (use /verbose on or /verbose off).`);
      return;
    }
    if (mode === "on" || mode === "true") {
      verbose = true;
      addSystemNote("[ultron] verbose on.");
    } else if (mode === "off" || mode === "false") {
      verbose = false;
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
    const res = await fetch("/api/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId }),
    });
    const data = await res.json();
    if (data.compacted) await selectChat(activeChatId);
    addSystemNote(
      data.compacted
        ? `[ultron] compacted ${data.before} messages into ${data.after} context messages.`
        : "[ultron] not enough history to compact yet.",
    );
    return;
  }

  if (command === "/retry") {
    await streamTurn({ chatId: activeChatId, retry: true, thinking: thinkingSelect.value });
    return;
  }

  if (command === "/stop") {
    await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId }),
    });
    return;
  }

  if (command === "/archive") {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId, title: arg || undefined }),
    });
    const data = await res.json();
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
    const res = await fetch("/api/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId, path: arg }),
    });
    const data = await res.json();
    if (res.ok) await selectChat(activeChatId);
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
  if (generating) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  closeCommandMenu();

  if (text.startsWith("/") && LOCAL_COMMANDS.includes(text.split(/\s+/)[0])) {
    runCommand(text);
    return;
  }

  addTurn("user").textContent = text;
  streamTurn({ chatId: activeChatId, text, thinking: thinkingSelect.value });
});

stopBtn.addEventListener("click", async () => {
  await fetch("/api/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId: activeChatId }),
  });
});

(async () => {
  await loadChats();
  const initial = chatsCache[0];
  if (initial) await selectChat(initial.id);
})();
