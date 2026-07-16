import { api } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { state } from "./store.js";
import { addTurn, addToolBlock, addSystemNote, clearThread, updateTurnActions } from "./thread.js";
import { loadStatus } from "./statusBar.js";
import { attachToRunningChat, setGenerating, syncSecurityMode } from "./composer.js";

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const chatListEl = document.getElementById("chat-list");
const newChatBtn = document.getElementById("new-chat-btn");
const activeChatTitle = document.getElementById("active-chat-title");

let handlers = { onAfterSelect: () => {} };
const collapsedAgents = new Set();

export function initChatList(injectedHandlers) {
  handlers = injectedHandlers;
  newChatBtn.addEventListener("click", () => createNewChat());
  sidebarToggle.addEventListener("click", () => sidebar.classList.toggle("collapsed"));
  window.addEventListener("agents:loaded", renderChatList);
}

export function toggleSidebar(force) {
  sidebar.classList.toggle("collapsed", force);
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
  const visibleChats = state.chatsCache.filter((chat) => !chat.scheduleId);
  if (visibleChats.length === 0 && state.agentsCache.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.textContent = "No chats yet";
    chatListEl.appendChild(empty);
    return;
  }

  const renderChat = (chat) => {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === state.activeChatId ? " active" : "");
    item.tabIndex = 0;

    const title = document.createElement("div");
    title.className = "chat-title";
    title.textContent = chat.title;
    title.title = `${chat.title} · ${timeAgo(chat.updatedAt)} ago`;
    if (chat.agentId) {
      const owner = state.agentsCache.find((agent) => agent.id === chat.agentId);
      if (owner) { title.textContent = `${owner.name} · ${chat.title}`; title.title = `${owner.name} · ${chat.title}`; }
    }

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
      if (chat.id !== state.activeChatId) selectChat(chat.id);
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && chat.id !== state.activeChatId) selectChat(chat.id);
    });
    return item;
  };

  const rootChats = visibleChats.filter((chat) => !chat.agentId);
  if (rootChats.length > 0) {
    const heading = document.createElement("div");
    heading.className = "chat-group-heading root-heading";
    heading.textContent = "ULTRON";
    chatListEl.appendChild(heading);
    rootChats.forEach((chat) => chatListEl.appendChild(renderChat(chat)));
  }

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
    if (value && value !== chat.title) await api.renameChat(chat.id, value);
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
  await api.deleteChat(chat.id);
  await loadChats();
  if (chat.id === state.activeChatId) {
    if (state.chatsCache.length > 0) await selectChat(state.chatsCache[0].id);
    else await createNewChat();
  }
}

export async function createNewChat() {
  const data = await api.createChat();
  await loadChats();
  await selectChat(data.chat.id);
}

export async function createAgentChat(agent) {
  const data = await api.createChat(undefined, agent.id);
  await loadChats();
  await selectChat(data.chat.id);
}

export async function loadChats() {
  const data = await api.listChats();
  state.chatsCache = data.chats;
  renderChatList();
  window.dispatchEvent(new Event("chats:loaded"));
}

export function getChat(id) {
  return state.chatsCache.find((c) => c.id === id);
}

export async function selectChat(id) {
  state.activeChatId = id;
  window.dispatchEvent(new Event("chat:selected"));
  renderChatList();
  clearThread();
  await loadStatus();
  const chat = getChat(id);
  activeChatTitle.textContent = chat ? chat.title : "ULTRON";
  syncSecurityMode(chat?.securityMode ?? "bypass");
  try {
    const data = await api.chatMessages(id);
    // tool_call/tool_result entries (see listChatMessages in graph.ts)
    // render as the same collapsible blocks a live turn uses (addToolBlock,
    // composer.js's streamTurn) — a chat replay that skipped them would
    // look empty for a chat that mostly ran tools, e.g. a spawned agent.
    let openToolBlock = null;
    for (const message of data.messages) {
      if (message.role === "human" || message.role === "ai") {
        const body = addTurn(message.role === "human" ? "user" : "assistant");
        if (message.role === "human") {
          body.textContent = message.content;
        } else {
          body.dataset.raw = message.content;
          body.innerHTML = renderMarkdown(message.content);
        }
        openToolBlock = null;
      } else if (message.role === "tool_call") {
        openToolBlock = addToolBlock(message.name, message.content);
        openToolBlock.dataset.name = message.name;
      } else if (message.role === "tool_result") {
        const match = openToolBlock && openToolBlock.dataset.name === message.name ? openToolBlock : null;
        if (match) match.textContent = message.content;
        openToolBlock = null;
      }
    }
    updateTurnActions();
    // The chat may still be a spawn_agent execution in progress (see
    // runs.ts) — attach to its live output instead of leaving the view
    // frozen on whatever history had been written by the time this loaded.
    // Otherwise, force-clear any stale "generating" state a still-finishing
    // attach to the *previous* chat left behind (it only clears itself if
    // it's still the active chat when its stream ends — see
    // attachToRunningChat's stillViewing() guard in composer.js).
    if (data.running) attachToRunningChat(id);
    else setGenerating(false);
  } catch {
    addSystemNote("[ultron] could not load chat history.", true);
  }
  if (window.innerWidth <= 860) sidebar.classList.add("collapsed");
  handlers.onAfterSelect();
}
