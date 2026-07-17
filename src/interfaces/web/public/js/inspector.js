import { api } from "./api.js";
import { initTheme } from "./theme.js";
import { state } from "./store.js";

const overlay = document.getElementById("inspector-overlay");
const closeBtn = document.getElementById("inspector-close");
const tabs = [...document.querySelectorAll(".inspector-tab")];
const toolLegend = document.getElementById("tool-legend");
const modelSelect = document.getElementById("model-select");

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

async function loadModels() {
  try {
    const data = await api.models();
    modelSelect.innerHTML = "";
    for (const model of data.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.id;
      modelSelect.appendChild(option);
    }
    modelSelect.value = data.current;
  } catch {
    modelSelect.innerHTML = '<option value="">Could not load models</option>';
  }
}

// No header button triggers this directly (removed — see index.html); it's
// reachable only via ⌘, / ⌘/ (shortcuts.js).
export function initInspector() {
  tabs.forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  initTheme({
    toggleBtn: document.getElementById("theme-toggle-btn"),
    select: document.getElementById("theme-select"),
  });

  loadToolLegend();
  loadModels();
  modelSelect.addEventListener("change", async () => {
    if (!modelSelect.value) return;
    try {
      await api.setModel(modelSelect.value);
      window.dispatchEvent(new Event("model:changed"));
    } catch {
      await loadModels();
    }
  });
}
