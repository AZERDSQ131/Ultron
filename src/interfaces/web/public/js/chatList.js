import { api } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { state } from "./store.js";
import { addTurn, addSystemNote, clearThread, updateTurnActions } from "./thread.js";
import { loadStatus } from "./statusBar.js";

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
  try {
    const data = await api.chatMessages(id);
    for (const message of data.messages) {
      const body = addTurn(message.role === "human" ? "user" : "assistant");
      if (message.role === "human") {
        body.textContent = message.content;
      } else {
        body.dataset.raw = message.content;
        body.innerHTML = renderMarkdown(message.content);
      }
    }
    updateTurnActions();
  } catch {
    addSystemNote("[ultron] could not load chat history.", true);
  }
  if (window.innerWidth <= 860) sidebar.classList.add("collapsed");
  handlers.onAfterSelect();
}
