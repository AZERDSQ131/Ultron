import { api } from "./api.js";
import { state } from "./store.js";

const modelLabel = document.getElementById("model-label");
const contextLabel = document.getElementById("context-label");
const contextFill = document.getElementById("context-fill");
const settingsModel = document.getElementById("settings-model");
const settingsToolCount = document.getElementById("settings-tool-count");
const modelMenu = document.getElementById("model-menu");
const modelSearch = document.getElementById("model-search");
const modelOptions = document.getElementById("model-options");
let availableModels = [];

export function updateContextGauge(usedTokens, maxTokens) {
  const ratio = Math.min(usedTokens / maxTokens, 1);
  contextFill.style.width = `${Math.round(ratio * 100)}%`;
  contextFill.classList.toggle("warn", ratio >= 0.5 && ratio < 0.8);
  contextFill.classList.toggle("hot", ratio >= 0.8);
  const maxLabel = maxTokens >= 1_000_000 ? `${maxTokens / 1_000_000}M` : `${Math.round(maxTokens / 1000)}k`;
  contextLabel.textContent = `${usedTokens.toLocaleString()} / ${maxLabel} tokens`;
}

export async function loadStatus() {
  try {
    const data = await api.status(state.activeChatId);
    modelLabel.textContent = data.model;
    settingsModel.textContent = data.model;
    settingsToolCount.textContent = String(data.toolCount);
    updateContextGauge(data.contextTokens, data.maxTokens);
    return data;
  } catch {
    modelLabel.textContent = "offline";
    return undefined;
  }
}

function renderModelOptions(query = "") {
  const matches = availableModels.filter((model) => model.id.toLowerCase().includes(query.toLowerCase()));
  modelOptions.innerHTML = matches.length ? "" : '<div class="model-empty">No matching NVIDIA models</div>';
  for (const model of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "model-option";
    option.setAttribute("role", "option");
    option.innerHTML = `<span>${model.id}</span><small>${model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString()} tokens` : "context unknown"}</small>`;
    option.addEventListener("click", async () => {
      await api.setModel(model.id);
      modelMenu.hidden = true;
      document.getElementById("model-label").setAttribute("aria-expanded", "false");
      await loadStatus();
    });
    modelOptions.appendChild(option);
  }
}

async function loadModelPicker() {
  try {
    availableModels = (await api.models()).models;
    renderModelOptions();
  } catch {
    modelOptions.innerHTML = '<div class="model-empty">Could not load models</div>';
  }
}

document.getElementById("model-label").addEventListener("click", () => {
  modelMenu.hidden = !modelMenu.hidden;
  document.getElementById("model-label").setAttribute("aria-expanded", String(!modelMenu.hidden));
  if (!modelMenu.hidden) { modelSearch.value = ""; modelSearch.focus(); renderModelOptions(); }
});
modelSearch.addEventListener("input", () => renderModelOptions(modelSearch.value));
document.addEventListener("click", (event) => {
  if (!modelMenu.hidden && !modelMenu.contains(event.target) && !document.getElementById("model-label").contains(event.target)) {
    modelMenu.hidden = true;
    document.getElementById("model-label").setAttribute("aria-expanded", "false");
  }
});
window.addEventListener("model:changed", loadStatus);
loadModelPicker();
