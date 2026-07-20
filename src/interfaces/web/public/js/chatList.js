import { api } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { state } from "./store.js";
import { addTurn, beginToolGroup, addSystemNote, clearThread, updateTurnActions } from "./thread.js";
import { loadStatus } from "./statusBar.js";
import { attachToRunningChat, setGenerating, syncSecurityMode } from "./composer.js";
import { closeHealthView } from "./healthView.js";
import { closeUsageView } from "./usageView.js";

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarScrim = document.getElementById("sidebar-scrim");
const chatListEl = document.getElementById("chat-list");
const newChatBtn = document.getElementById("new-chat-btn");
const activeChatTitle = document.getElementById("active-chat-title");

let handlers = { onAfterSelect: () => {} };

export function initChatList(injectedHandlers) {
  handlers = injectedHandlers;
  newChatBtn.addEventListener("click", () => createNewChat());
  sidebarToggle.addEventListener("click", () => sidebar.classList.toggle("collapsed"));
  sidebarScrim.addEventListener("click", () => sidebar.classList.add("collapsed"));
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

// Schedule-owned chats still show here, grouped chronologically like
// ChatGPT's sidebar (Today / Yesterday / Previous 7 days / a bucket per
// older month), with a ⏰ badge. Agent-owned chats (chat.agentId set) are
// deliberately excluded from this list — they clutter the day-to-day
// timeline with sub-agent runs that aren't really "today's conversations"
// — and are reached from the Agents panel instead (automation.js), by
// clicking an agent to open its most recent chat.
function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function groupChats(chats) {
  const now = new Date();
  const today = dayKey(now.toISOString());
  const yesterday = dayKey(new Date(now.getTime() - 86400000).toISOString());
  const weekAgo = now.getTime() - 7 * 86400000;

  const groups = new Map();
  const order = [];
  const push = (label, chat) => {
    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label).push(chat);
  };

  for (const chat of chats) {
    const t = new Date(chat.updatedAt).getTime();
    const key = dayKey(chat.updatedAt);
    if (key === today) push("Today", chat);
    else if (key === yesterday) push("Yesterday", chat);
    else if (t >= weekAgo) push("Previous 7 days", chat);
    else push(new Date(chat.updatedAt).toLocaleString(undefined, { month: "long", year: t < new Date(now.getFullYear(), 0, 1).getTime() ? "numeric" : undefined }), chat);
  }
  return order.map((label) => ({ label, chats: groups.get(label) }));
}

function chatBadge(chat) {
  if (chat.scheduleId) return { icon: "⏰", label: "scheduled run" };
  return null;
}

function renderChatList() {
  chatListEl.innerHTML = "";
  const allChats = [...state.chatsCache].filter((chat) => !chat.agentId).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  if (allChats.length === 0) {
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

    const badge = chatBadge(chat);
    if (badge) {
      const badgeEl = document.createElement("span");
      badgeEl.className = "chat-badge";
      badgeEl.textContent = badge.icon;
      badgeEl.title = badge.label;
      item.appendChild(badgeEl);
    }

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
      if (chat.id !== state.activeChatId) selectChat(chat.id);
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && chat.id !== state.activeChatId) selectChat(chat.id);
    });
    return item;
  };

  for (const group of groupChats(allChats)) {
    const heading = document.createElement("div");
    heading.className = "chat-group-heading";
    heading.textContent = group.label;
    chatListEl.appendChild(heading);
    group.chats.forEach((chat) => chatListEl.appendChild(renderChat(chat)));
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
  closeHealthView();
  closeUsageView();
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
    // render as the same grouped, collapsible "tool calls" block a live
    // turn uses (beginToolGroup, composer.js's streamTurn) — a chat replay
    // that skipped them would look empty for a chat that mostly ran tools,
    // e.g. a spawned agent. live: false since replayed messages carry no
    // reliable timing to show a "worked for Xs" duration.
    let openToolBlock = null;
    let toolGroup = null;
    let currentAssistantBody = null;
    for (const message of data.messages) {
      if (message.role === "human") {
        addTurn("user").textContent = message.content;
        openToolBlock = null;
        toolGroup = null;
        currentAssistantBody = null;
      } else if (message.role === "ai") {
        const body = addTurn("assistant");
        body.dataset.raw = message.content;
        body.innerHTML = renderMarkdown(message.content);
        openToolBlock = null;
        currentAssistantBody = body;
      } else if (message.role === "tool_call") {
        if (!toolGroup) toolGroup = beginToolGroup(currentAssistantBody, { live: false });
        openToolBlock = toolGroup.addCall(message.name, message.content);
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
