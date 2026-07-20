import { api } from "./api.js";
import { state } from "./store.js";
import { createAgentChat, loadChats, selectChat } from "./chatList.js";

const panel = document.getElementById("automation-panel");
const agentList = document.getElementById("agent-list");
const scheduleList = document.getElementById("schedule-list");
const dialog = document.getElementById("automation-dialog");
const form = document.getElementById("automation-form");
const title = document.getElementById("automation-dialog-title");
const description = document.getElementById("automation-description");
const instructions = document.getElementById("automation-instructions");
let agents = [];

function openDialog() {
  title.textContent = "New agent";
  form.dataset.kind = "agent";
  form.reset();
  dialog.hidden = false;
  document.getElementById("automation-name").focus();
}
function closeDialog() { dialog.hidden = true; }

// Agent-owned (and schedule-owned) conversations now live in the unified
// sidebar chat list (see chatList.js's groupChats/chatBadge — 🤖/⏰ badges),
// so this panel is purely agent/schedule management: create, delete, and
// "start a new chat with this agent" — not a second place to browse their
// past conversations.
function render() {
  agentList.innerHTML = agents.length ? agents.map((a) => {
    const chatCount = state.chatsCache.filter((chat) => chat.agentId === a.id).length;
    return `<div class="automation-item agent-item"><span class="agent-dot"></span><span class="agent-name" title="${a.description}">${a.name}</span><span class="agent-count dim">${chatCount} chat${chatCount === 1 ? "" : "s"}</span><span class="agent-actions"><button class="agent-chat-btn" data-agent-id="${a.id}" title="Start a chat with ${a.name}" aria-label="Start a chat with ${a.name}">+</button><button class="agent-delete-btn" data-agent-id="${a.id}" title="Delete ${a.name}" aria-label="Delete ${a.name}">🗑</button></span></div>`;
  }).join("") : '<div class="empty-hint">No agents</div>';
  agentList.querySelectorAll(".agent-chat-btn").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const agent = agents.find((candidate) => candidate.id === button.dataset.agentId);
    if (agent) await createAgentChat(agent);
  }));
  agentList.querySelectorAll(".agent-delete-btn").forEach((button) => button.addEventListener("click", async () => {
    const agent = agents.find((candidate) => candidate.id === button.dataset.agentId);
    if (!agent || !confirm(`Delete Agent \"${agent.name}\" and all its conversations?`)) return;
    await api.deleteAgent(agent.id);
    if (state.chatsCache.some((chat) => chat.agentId === agent.id && chat.id === state.activeChatId)) state.activeChatId = null;
    await loadChats();
    await load();
  }));
}
async function load() {
  const [agentData, scheduleData] = await Promise.all([api.listAgents(), api.listSchedules()]);
  agents = agentData.agents;
  state.agentsCache = agents;
  window.dispatchEvent(new Event("agents:loaded"));
  render();
  scheduleList.innerHTML = scheduleData.schedules.length ? scheduleData.schedules.map((s) => {
    const completed = s.cron === "@once" && s.lastRunAt;
    const remaining = completed ? Math.max(0, 3600 - Math.floor((Date.now() - new Date(s.lastRunAt).getTime()) / 1000)) : null;
    const timer = remaining === null ? (s.cron === "@once" ? "pending" : s.cron) : `deletes in ${Math.floor(remaining / 60)}m ${remaining % 60}s`;
    return `<div class="automation-item schedule-item${s.lastRunChatId ? " clickable" : ""}" data-chat-id="${s.lastRunChatId ?? ""}"><span title="${s.instruction}">${s.name}<small class="schedule-timer">${timer}</small></span><button class="schedule-delete" data-id="${s.id}" title="Delete task" aria-label="Delete task">×</button></div>`;
  }).join("") : '<div class="empty-hint">No schedules</div>';
  scheduleList.querySelectorAll(".schedule-item[data-chat-id]").forEach((item) => item.addEventListener("click", async (event) => { if (event.target.closest("button")) return; await selectChat(item.dataset.chatId); }));
  scheduleList.querySelectorAll(".schedule-delete").forEach((button) => button.addEventListener("click", async () => { if (confirm("Delete this scheduled task?")) { await api.deleteSchedule(button.dataset.id); await load(); } }));
}
export function initAutomation() {
  document.getElementById("new-agent-btn").addEventListener("click", () => openDialog("agent"));
  
  document.getElementById("automation-cancel").addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("automation-name").value.trim();
    await api.createAgent({ name, description: description.value, instructions: instructions.value });
    closeDialog();
    await load();
  });
  load().catch(() => { panel.querySelector(".empty-hint")?.replaceChildren(document.createTextNode("Could not load automation")); });
  window.addEventListener("chats:loaded", render);
  window.addEventListener("chat:selected", render);
  // A schedule is created by the model during a streaming turn, so the
  // sidebar needs a small polling refresh to see it without a full reload.
  setInterval(() => load().catch(() => {}), 1000);
}
