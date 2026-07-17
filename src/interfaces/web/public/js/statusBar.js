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
const modelPickerButton = document.getElementById("model-picker-btn");
const activeModelName = document.getElementById("active-model-name");
const modelCount = document.getElementById("model-count");
let availableModels = [];
let activeModel = "";

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
    activeModel = data.model;
    modelLabel.textContent = data.model;
    activeModelName.textContent = data.model;
    settingsModel.textContent = data.model;
    settingsToolCount.textContent = String(data.toolCount);
    updateContextGauge(data.contextTokens, data.maxTokens);
    if (availableModels.length) renderModelOptions(modelSearch.value);
    return data;
  } catch {
    modelLabel.textContent = "offline";
    return undefined;
  }
}

function renderModelOptions(query = "") {
  const matches = availableModels.filter((model) => model.id.toLowerCase().includes(query.toLowerCase()));
  modelCount.textContent = `${matches.length} ${matches.length === 1 ? "model" : "models"}`;
  modelOptions.innerHTML = "";
  if (!matches.length) {
    modelOptions.innerHTML = '<div class="model-empty">No matching models</div>';
    return;
  }
  for (const model of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `model-option${model.id === activeModel ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(model.id === activeModel));
    const check = document.createElement("span");
    check.className = "model-option-check";
    check.textContent = model.id === activeModel ? "✓" : "";
    const name = document.createElement("span");
    name.className = "model-option-name";
    name.textContent = model.id;
    const context = document.createElement("small");
    context.textContent = model.contextWindowTokens ? `${model.contextWindowTokens.toLocaleString()} context` : "context unknown";
    const meta = document.createElement("span");
    meta.className = "model-option-meta";
    meta.append(context);
    option.append(check, name, meta);
    option.addEventListener("click", async () => {
      await api.setModel(model.id);
      activeModel = model.id;
      modelMenu.hidden = true;
      modelPickerButton.setAttribute("aria-expanded", "false");
      await loadStatus();
    });
    modelOptions.appendChild(option);
  }
}

async function loadModelPicker() {
  try {
    availableModels = (await api.models()).models;
    if (!activeModel) activeModel = availableModels.find((model) => model.id === (modelLabel.textContent ?? ""))?.id ?? "";
    renderModelOptions();
  } catch {
    modelOptions.innerHTML = '<div class="model-empty">Could not load models</div>';
  }
}

modelPickerButton.addEventListener("click", () => {
  modelMenu.hidden = !modelMenu.hidden;
  modelPickerButton.setAttribute("aria-expanded", String(!modelMenu.hidden));
  if (!modelMenu.hidden) { modelSearch.value = ""; modelSearch.focus(); renderModelOptions(); }
});
modelSearch.addEventListener("input", () => renderModelOptions(modelSearch.value));
document.addEventListener("click", (event) => {
  if (!modelMenu.hidden && !modelMenu.contains(event.target) && !modelPickerButton.contains(event.target)) {
    modelMenu.hidden = true;
    modelPickerButton.setAttribute("aria-expanded", "false");
  }
});
window.addEventListener("model:changed", loadStatus);
loadModelPicker();
