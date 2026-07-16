import { api } from "./api.js";
import { state } from "./store.js";
import { selectChat } from "./chatList.js";
import { COMMANDS, prefillCommand } from "./composer.js";

const overlay = document.getElementById("palette-overlay");
const paletteInput = document.getElementById("palette-input");
const results = document.getElementById("palette-results");

let flatItems = [];
let activeIndex = 0;
let searchToken = 0;

function highlight(text, query) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return `${text.slice(0, idx)}<mark>${text.slice(idx, idx + query.length)}</mark>${text.slice(idx + query.length)}`;
}

function itemEl(icon, title, sub, onSelect) {
  const el = document.createElement("div");
  el.className = "palette-item";
  el.innerHTML = `<span class="p-icon">${icon}</span><span class="p-main"><span class="p-title">${title}</span>${
    sub ? `<span class="p-sub">${sub}</span>` : ""
  }</span>`;
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    onSelect();
  });
  return { el, onSelect };
}

function groupLabel(text) {
  const el = document.createElement("div");
  el.className = "palette-group-label";
  el.textContent = text;
  return el;
}

function renderEmpty(text) {
  results.innerHTML = "";
  const el = document.createElement("div");
  el.className = "palette-empty";
  el.textContent = text;
  results.appendChild(el);
}

function paintActive() {
  [...results.querySelectorAll(".palette-item")].forEach((el, i) => el.classList.toggle("active", i === activeIndex));
  const activeEl = results.querySelectorAll(".palette-item")[activeIndex];
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

async function runQuery(query) {
  const token = ++searchToken;
  results.innerHTML = "";
  flatItems = [];
  activeIndex = 0;

  const trimmed = query.trim();

  if (trimmed.startsWith("/")) {
    const matches = COMMANDS.filter((c) => c.name.startsWith(trimmed));
    if (matches.length === 0) return renderEmpty("No matching command");
    results.appendChild(groupLabel("Commands"));
    for (const cmd of matches) {
      const { el, onSelect } = itemEl("/", `<mark>${cmd.name}</mark>`, cmd.desc, () => {
        prefillCommand(cmd.name);
        close();
      });
      results.appendChild(el);
      flatItems.push(onSelect);
    }
    paintActive();
    return;
  }

  if (!trimmed) {
    if (state.chatsCache.length === 0) return renderEmpty("No chats yet — start one from the sidebar");
    results.appendChild(groupLabel("Recent chats"));
    for (const chat of state.chatsCache.slice(0, 8)) {
      const { el, onSelect } = itemEl("○", chat.title, chat.id === state.activeChatId ? "current" : "", () => {
        selectChat(chat.id);
        close();
      });
      results.appendChild(el);
      flatItems.push(onSelect);
    }
    paintActive();
    return;
  }

  const chatMatches = state.chatsCache.filter((c) => c.title.toLowerCase().includes(trimmed.toLowerCase())).slice(0, 6);
  if (chatMatches.length) {
    results.appendChild(groupLabel("Chats"));
    for (const chat of chatMatches) {
      const { el, onSelect } = itemEl("○", highlight(chat.title, trimmed), "", () => {
        selectChat(chat.id);
        close();
      });
      results.appendChild(el);
      flatItems.push(onSelect);
    }
  }

  let searchData;
  try {
    searchData = await api.search(trimmed);
  } catch {
    searchData = { results: [] };
  }
  if (token !== searchToken) return; // a newer keystroke superseded this request

  if (searchData.results?.length) {
    results.appendChild(groupLabel("Messages"));
    for (const chatResult of searchData.results) {
      for (const match of chatResult.matches) {
        const { el, onSelect } = itemEl(
          match.role === "human" ? "you" : "ai",
          highlight(match.snippet, trimmed),
          chatResult.chatTitle,
          () => {
            selectChat(chatResult.chatId);
            close();
          },
        );
        results.appendChild(el);
        flatItems.push(onSelect);
      }
    }
  }

  if (!chatMatches.length && !searchData.results?.length) renderEmpty(`No results for "${trimmed}"`);
  else paintActive();
}

let debounceTimer;
paletteInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runQuery(paletteInput.value), 120);
});

paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (flatItems.length) {
      activeIndex = (activeIndex + 1) % flatItems.length;
      paintActive();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (flatItems.length) {
      activeIndex = (activeIndex - 1 + flatItems.length) % flatItems.length;
      paintActive();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    flatItems[activeIndex]?.();
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
});

overlay.addEventListener("mousedown", (e) => {
  if (e.target === overlay) close();
});

export function open() {
  overlay.hidden = false;
  paletteInput.value = "";
  paletteInput.focus();
  runQuery("");
}

export function close() {
  overlay.hidden = true;
}

export function isOpen() {
  return !overlay.hidden;
}

export function initPalette() {
  document.getElementById("search-launch-btn").addEventListener("click", open);
}
