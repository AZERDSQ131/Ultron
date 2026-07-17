// Right-side to-do panel — mirrors the todo_write/todo_read tools
// (core/tools/todos.js) so the user can follow a long task's progress
// without reading the whole transcript. Purely a read view: the model is
// the only writer, via the tools.
import { api } from "./api.js";
import { state } from "./store.js";

const panel = document.getElementById("todo-panel");
const list = document.getElementById("todo-list");
const countEl = document.getElementById("todo-count");
const clearBtn = document.getElementById("todo-clear-btn");

const STATUS_LABEL = { pending: "To do", in_progress: "In progress", completed: "Done" };

export function initTodos() {
  // Clears synchronously on chat switch, before the fetch below even
  // starts — each chat's list is correctly scoped server-side already
  // (todos are stored per chat_id, see memory/todos.ts), but without this
  // the panel kept showing the previous chat's items for the length of one
  // network round trip, which reads as "the new chat has a to-do" for a
  // beat. A brand new chat has no list at all, so it should never show one.
  window.addEventListener("chat:selected", () => {
    renderTodos([]);
    refreshTodos();
  });

  // The list otherwise persists across turns indefinitely (see todoState in
  // graph.ts) — including into a later, unrelated request in the same
  // chat, since nothing about a fresh message tells the model on its own
  // that the previous task is done. This is the deterministic escape
  // hatch: the user can always force a clean slate instead of depending on
  // the model noticing.
  clearBtn.addEventListener("click", async () => {
    if (!state.activeChatId) return;
    if (!confirm("Clear the to-do list for this chat?")) return;
    await api.clearTodos(state.activeChatId);
    renderTodos([]);
  });
}

export async function refreshTodos() {
  const chatId = state.activeChatId;
  if (!chatId) return;
  let items = [];
  try {
    const data = await api.chatTodos(chatId);
    items = data.items ?? [];
  } catch {
    return;
  }
  // The active chat may have changed while this request was in flight.
  if (chatId !== state.activeChatId) return;
  renderTodos(items);
}

function renderTodos(items) {
  list.innerHTML = "";
  panel.classList.toggle("empty", items.length === 0);
  const done = items.filter((item) => item.status === "completed").length;
  countEl.textContent = items.length ? `${done}/${items.length}` : "";
  clearBtn.hidden = items.length === 0;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.textContent = "No to-do list for this chat yet.";
    list.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = `todo-item status-${item.status}`;

    const mark = document.createElement("span");
    mark.className = "todo-mark";
    mark.textContent = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○";

    const content = document.createElement("span");
    content.className = "todo-content";
    content.textContent = item.content;

    row.title = STATUS_LABEL[item.status] ?? item.status;
    row.append(mark, content);
    list.appendChild(row);
  }
}
