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
  archive: (chatId, title) =>
    fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, title }),
    }).then(json),
  resume: (chatId, path) =>
    fetch("/api/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, path }),
    }),
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
  setModel: (model) => fetch("/api/model", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }).then(json),
  search: (query) => fetch(`/api/search?q=${encodeURIComponent(query)}`).then(json),
  listAgents: () => fetch("/api/agents").then(json),
  createAgent: (body) => fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json),
  deleteAgent: (id) => fetch(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),
  listSchedules: () => fetch("/api/schedules").then(json),
  createSchedule: (body) => fetch("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json),
  toggleSchedule: (id, enabled) => fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }).then(json),
  deleteSchedule: (id) => fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),
};
