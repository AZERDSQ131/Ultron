import { api } from "./api.js";
import { state } from "./store.js";
import { createAgentChat } from "./chatList.js";

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
function render() {
  agentList.innerHTML = agents.length ? agents.map((a) => `<div class="automation-item agent-item"><span class="agent-dot"></span><span class="agent-name" title="${a.description}">${a.name}</span><button class="agent-chat-btn" data-agent-id="${a.id}" title="Start a chat with ${a.name}" aria-label="Start a chat with ${a.name}">↗</button></div>`).join("") : '<div class="empty-hint">No agents</div>';
  agentList.querySelectorAll(".agent-chat-btn").forEach((button) => button.addEventListener("click", async () => {
    const agent = agents.find((candidate) => candidate.id === button.dataset.agentId);
    if (agent) await createAgentChat(agent);
  }));
}
async function load() {
  const [agentData, scheduleData] = await Promise.all([api.listAgents(), api.listSchedules()]);
  agents = agentData.agents;
  state.agentsCache = agents;
  window.dispatchEvent(new Event("agents:loaded"));
  render();
  scheduleList.innerHTML = scheduleData.schedules.length ? scheduleData.schedules.map((s) => `<div class="automation-item schedule-item"><span title="${s.instruction}">${s.name}</span><small>${s.cron}</small><button data-id="${s.id}" data-enabled="${s.enabled}" title="Enable/disable">${s.enabled ? "●" : "○"}</button></div>`).join("") : '<div class="empty-hint">No schedules</div>';
  scheduleList.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => { await api.toggleSchedule(button.dataset.id, button.dataset.enabled !== "true"); load(); }));
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
}
