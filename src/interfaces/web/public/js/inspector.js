import { api } from "./api.js";
import { initTheme } from "./theme.js";
import { state } from "./store.js";

const overlay = document.getElementById("inspector-overlay");
const closeBtn = document.getElementById("inspector-close");
const tabs = [...document.querySelectorAll(".inspector-tab")];
const toolLegend = document.getElementById("tool-legend");
const settingsBtn = document.getElementById("settings-btn");
const shortcutsBtn = document.getElementById("shortcuts-btn");

function showTab(name) {
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.getElementById("inspector-panel-settings").hidden = name !== "settings";
  document.getElementById("inspector-panel-shortcuts").hidden = name !== "shortcuts";
}

export function open(tab = "settings") {
  showTab(tab);
  overlay.hidden = false;
}

export function close() {
  overlay.hidden = true;
}

export function isOpen() {
  return !overlay.hidden;
}

async function loadToolLegend() {
  try {
    const { tools } = await api.tools();
    state.toolScopes = Object.fromEntries(tools.map((t) => [t.name, t.scope]));
    toolLegend.innerHTML = "";
    for (const tool of tools) {
      const row = document.createElement("div");
      row.className = "tl-item";
      row.innerHTML =
        `<span class="tool-badge scope-badge-${tool.scope}">${tool.scope}</span>` +
        `<span class="tl-name">${tool.name}</span>`;
      row.title = tool.description;
      toolLegend.appendChild(row);
    }
  } catch {
    toolLegend.textContent = "Could not load tool list.";
  }
}

export function initInspector() {
  tabs.forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  settingsBtn.addEventListener("click", () => (isOpen() && document.querySelector('.inspector-tab[data-tab="settings"]').classList.contains("active") ? close() : open("settings")));
  shortcutsBtn.addEventListener("click", () => (isOpen() && document.querySelector('.inspector-tab[data-tab="shortcuts"]').classList.contains("active") ? close() : open("shortcuts")));

  initTheme({
    toggleBtn: document.getElementById("theme-toggle-btn"),
    select: document.getElementById("theme-select"),
  });

  loadToolLegend();
}
