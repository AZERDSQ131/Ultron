import { api } from "./api.js";
import { state } from "./store.js";
import { createAgentChat, selectChat } from "./chatList.js";

const panel = document.getElementById("automation-panel");
const agentList = document.getElementById("agent-list");
const scheduleList = document.getElementById("schedule-list");
const dialog = document.getElementById("automation-dialog");
const form = document.getElementById("automation-form");
const title = document.getElementById("automation-dialog-title");
const description = document.getElementById("automation-description");
const instructions = document.getElementById("automation-instructions");
let agents = [];
const collapsedAgents = new Set();

function openDialog() {
  title.textContent = "New agent";
  form.dataset.kind = "agent";
  form.reset();
  dialog.hidden = false;
  document.getElementById("automation-name").focus();
}
function closeDialog() { dialog.hidden = true; }
function render() {
  agentList.innerHTML = agents.length ? agents.map((a) => {
    const agentChats = state.chatsCache.filter((chat) => chat.agentId === a.id && !chat.scheduleId);
    const chats = agentChats.map((chat) => `<button class="agent-chat-entry${chat.id === state.activeChatId ? " active" : ""}" data-chat-id="${chat.id}">${chat.title}</button>`).join("");
    const collapsed = collapsedAgents.has(a.id);
    return `<div class="agent-block"><div class="automation-item agent-item"><button class="agent-toggle" data-agent-id="${a.id}" title="${collapsed ? "Expand" : "Collapse"} conversations">${collapsed ? "▸" : "▾"}</button><span class="agent-dot"></span><span class="agent-name" title="${a.description}">${a.name}</span><button class="agent-chat-btn" data-agent-id="${a.id}" title="Start a chat with ${a.name}" aria-label="Start a chat with ${a.name}">+</button></div>${collapsed ? "" : `<div class="agent-conversations">${chats || '<div class="agent-empty">No conversations</div>'}</div>`}</div>`;
  }).join("") : '<div class="empty-hint">No agents</div>';
  agentList.querySelectorAll(".agent-chat-btn").forEach((button) => button.addEventListener("click", async () => {
    const agent = agents.find((candidate) => candidate.id === button.dataset.agentId);
    if (agent) await createAgentChat(agent);
  }));
  agentList.querySelectorAll(".agent-toggle").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.agentId; if (collapsedAgents.has(id)) collapsedAgents.delete(id); else collapsedAgents.add(id); render(); }));
  agentList.querySelectorAll(".agent-chat-entry").forEach((button) => button.addEventListener("click", async () => { await selectChat(button.dataset.chatId); render(); }));
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
