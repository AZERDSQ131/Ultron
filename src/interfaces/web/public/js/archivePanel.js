// /archive and /resume: archiving flips a metadata flag on the current chat
// row (see ChatRegistry.archive) rather than exporting text, so /resume
// reopens a chat with its full LangGraph checkpoint state intact — not a
// lossy reconstruction. This module owns both dialogs.

import { api } from "./api.js";
import { state } from "./store.js";
import { loadChats, selectChat, getChat } from "./chatList.js";
import { addSystemNote } from "./thread.js";

const archiveDialog = document.getElementById("archive-dialog");
const archiveForm = document.getElementById("archive-form");
const archiveTitleInput = document.getElementById("archive-title");
const archiveCancelBtn = document.getElementById("archive-cancel");

const resumeOverlay = document.getElementById("resume-overlay");
const resumeInput = document.getElementById("resume-input");
const resumeResults = document.getElementById("resume-results");

let archivedCache = [];
let activeIndex = 0;

export function openArchiveDialog() {
  const chat = getChat(state.activeChatId);
  archiveTitleInput.value = chat?.title ?? "";
  archiveDialog.hidden = false;
  archiveTitleInput.focus();
  archiveTitleInput.select();
}

function closeArchiveDialog() {
  archiveDialog.hidden = true;
}

archiveCancelBtn.addEventListener("click", closeArchiveDialog);
archiveDialog.addEventListener("mousedown", (e) => { if (e.target === archiveDialog) closeArchiveDialog(); });

archiveForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const chatId = state.activeChatId;
  const title = archiveTitleInput.value.trim();
  closeArchiveDialog();
  const data = await api.archiveChat(chatId, title || undefined);
  await loadChats();
  await selectChat(data.fresh.id);
  addSystemNote(`[ultron] archived "${data.archived?.title ?? title}". Started a new chat.`);
});

function itemEl(chat, query) {
  const el = document.createElement("div");
  el.className = "palette-item";
  const label = query
    ? chat.title.replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"), "<mark>$1</mark>")
    : chat.title;
  el.innerHTML = `<span class="p-icon">□</span><span class="p-main"><span class="p-title">${label || "(untitled)"}</span></span>`;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "p-delete";
  del.textContent = "🗑";
  del.title = "Delete permanently";
  del.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${chat.title}" permanently? This removes its full history.`)) return;
    await api.deleteChat(chat.id);
    await renderResults(resumeInput.value);
  });
  el.appendChild(del);
  el.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    await invoke(chat);
  });
  return el;
}

async function invoke(chat) {
  closeResumePanel();
  await api.resumeChat(chat.id);
  await loadChats();
  await selectChat(chat.id);
  addSystemNote(`[ultron] resumed "${chat.title}".`);
}

async function renderResults(query) {
  const trimmed = query.trim();
  const matches = trimmed
    ? archivedCache.filter((chat) => chat.title.toLowerCase().includes(trimmed.toLowerCase()))
    : archivedCache;
  activeIndex = 0;
  resumeResults.innerHTML = "";
  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = archivedCache.length === 0 ? "No archived chats" : `No results for "${trimmed}"`;
    resumeResults.appendChild(empty);
    return;
  }
  matches.forEach((chat, i) => {
    const el = itemEl(chat, trimmed);
    if (i === activeIndex) el.classList.add("active");
    resumeResults.appendChild(el);
  });
}

export async function openResumePanel() {
  const data = await api.listArchivedChats();
  archivedCache = data.chats;
  resumeOverlay.hidden = false;
  resumeInput.value = "";
  resumeInput.focus();
  await renderResults("");
}

function closeResumePanel() {
  resumeOverlay.hidden = true;
}

let debounceTimer;
resumeInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => renderResults(resumeInput.value), 100);
});

resumeInput.addEventListener("keydown", (e) => {
  const items = [...resumeResults.querySelectorAll(".palette-item")];
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length) { activeIndex = (activeIndex + 1) % items.length; items.forEach((el, i) => el.classList.toggle("active", i === activeIndex)); }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length) { activeIndex = (activeIndex - 1 + items.length) % items.length; items.forEach((el, i) => el.classList.toggle("active", i === activeIndex)); }
  } else if (e.key === "Enter") {
    e.preventDefault();
    items[activeIndex]?.dispatchEvent(new MouseEvent("mousedown"));
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeResumePanel();
  }
});

resumeOverlay.addEventListener("mousedown", (e) => { if (e.target === resumeOverlay) closeResumePanel(); });

export function initArchivePanel() {}
