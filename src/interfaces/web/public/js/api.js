// Thin fetch wrappers — one function per backend route, so every other
// module talks to the server through here instead of building fetch calls
// inline. Kept boring on purpose: no caching, no retries, just the shape of
// each request/response documented in one place.

async function json(res) {
  return res.json();
}

export const api = {
  listChats: () => fetch("/api/chats").then(json),
  createChat: (title, agentId = null) =>
    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(title ? { title } : {}), ...(agentId ? { agentId } : {}) }),
    }).then(json),
  renameChat: (id, title) =>
    fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  deleteChat: (id) => fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setSecurityMode: (id, mode) =>
    fetch(`/api/chats/${encodeURIComponent(id)}/security`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json),
  chatMessages: (id) => fetch(`/api/chats/${encodeURIComponent(id)}/messages`).then(json),
  chatTodos: (id) => fetch(`/api/chats/${encodeURIComponent(id)}/todos`).then(json),
  clearTodos: (id) => fetch(`/api/chats/${encodeURIComponent(id)}/todos`, { method: "DELETE" }).then(json),

  stop: (chatId) =>
    fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    }),
  compact: (chatId) =>
    fetch("/api/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    }).then(json),
  listArchivedChats: () => fetch("/api/chats/archived").then(json),
  archiveChat: (chatId, title) =>
    fetch(`/api/chats/${encodeURIComponent(chatId)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    }).then(json),
  resumeChat: (chatId) => fetch(`/api/chats/${encodeURIComponent(chatId)}/resume`, { method: "POST" }).then(json),
  edit: (chatId) =>
    fetch("/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    }),
  status: (chatId) => fetch(`/api/status?chatId=${encodeURIComponent(chatId ?? "")}`).then(json),
  health: () => fetch("/api/health").then(json),
  tools: () => fetch("/api/tools").then(json),
  skills: () => fetch("/api/skills").then(json),
  installSkill: (name) => fetch("/api/skills/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).then(json),
  models: () => fetch("/api/models").then(json),
  modelsGrouped: () => fetch("/api/models/grouped").then(json),
  setModel: (model) => fetch("/api/model", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }).then(json),
  provider: () => fetch("/api/provider").then(json),
  setProvider: (provider) => fetch("/api/provider", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) }).then(json),
  search: (query) => fetch(`/api/search?q=${encodeURIComponent(query)}`).then(json),
  listAgents: () => fetch("/api/agents").then(json),
  createAgent: (body) => fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json),
  deleteAgent: (id) => fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),
  listSchedules: () => fetch("/api/schedules").then(json),
  createSchedule: (body) => fetch("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json),
  toggleSchedule: (id, enabled) => fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }).then(json),
  deleteSchedule: (id) => fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),
  main: () => fetch("/api/main", { method: "POST" }).then(json),
  getExport: (chatId) => fetch(`/api/chats/${encodeURIComponent(chatId)}/export`).then(json),
  setExport: (chatId, path) =>
    fetch(`/api/chats/${encodeURIComponent(chatId)}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then(json),
  stopExport: (chatId) => fetch(`/api/chats/${encodeURIComponent(chatId)}/export`, { method: "DELETE" }).then(json),
  uploadFile: (chatId, filename, dataBase64) =>
    fetch(`/api/chats/${encodeURIComponent(chatId)}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, dataBase64 }),
    }).then(json),
  memoryList: () => fetch("/api/memory").then(json),
  memoryClear: () => fetch("/api/memory", { method: "DELETE" }).then(json),
  memoryForget: (id) => fetch(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),
  healthSummary: () => fetch("/api/health-data/summary").then(json),
  usageSummary: (days = 30) => fetch(`/api/usage/summary?days=${encodeURIComponent(days)}`).then(json),
  financeSummary: (days = 30) => fetch(`/api/finance/summary?days=${encodeURIComponent(days)}`).then(json),
  financeCreateAccount: (name, type, currency) =>
    fetch("/api/finance/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type, currency }) }).then(json),
  financeDeleteAccount: (id) => fetch(`/api/finance/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),
  financeRecordBalance: (id, balance, date) =>
    fetch(`/api/finance/accounts/${encodeURIComponent(id)}/balance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ balance, date }) }).then(json),
  financeAddTransaction: (id, description, amount, date, category) =>
    fetch(`/api/finance/accounts/${encodeURIComponent(id)}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description, amount, date, category }) }).then(json),
};
