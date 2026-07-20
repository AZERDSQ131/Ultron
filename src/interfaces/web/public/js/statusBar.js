import { api } from "./api.js";
import { state } from "./store.js";
import { updateGoalWidget } from "./goalWidget.js";

const modelLabel = document.getElementById("model-label");
const contextLabel = document.getElementById("context-label");
const contextFill = document.getElementById("context-fill");
const settingsModel = document.getElementById("settings-model");
const settingsProvider = document.getElementById("settings-provider");
const settingsToolCount = document.getElementById("settings-tool-count");
const modelMenu = document.getElementById("model-menu");
const modelSearch = document.getElementById("model-search");
const modelOptions = document.getElementById("model-options");
const modelPickerButton = document.getElementById("model-picker-btn");
const activeModelName = document.getElementById("active-model-name");
const modelCount = document.getElementById("model-count");
let availableModels = [];
let activeModel = "";
let activeProvider = "";

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
    activeProvider = data.provider ?? activeProvider;
    modelLabel.textContent = data.model;
    activeModelName.textContent = data.model;
    settingsModel.textContent = data.model;
    settingsProvider.textContent = data.provider ?? "—";
    settingsToolCount.textContent = String(data.toolCount);
    updateContextGauge(data.contextTokens, data.maxTokens);
    updateGoalWidget(data.goal);
    if (availableModels.length) renderModelOptions(modelSearch.value);
    return data;
  } catch {
    modelLabel.textContent = "offline";
    return undefined;
  }
}

function renderModelOptions(query = "") {
  const matches = availableModels.filter((model) => `${model.provider}/${model.id}`.toLowerCase().includes(query.toLowerCase()));
  modelCount.textContent = `${matches.length} ${matches.length === 1 ? "model" : "models"}`;
  modelOptions.innerHTML = "";
  if (!matches.length) {
    modelOptions.innerHTML = '<div class="model-empty">No matching models</div>';
    return;
  }
  let lastProvider;
  for (const model of matches) {
    if (model.provider !== lastProvider) {
      lastProvider = model.provider;
      const header = document.createElement("div");
      header.className = "model-group-heading";
      header.textContent = model.provider;
      modelOptions.appendChild(header);
    }
    const isActive = model.id === activeModel && model.provider === activeProvider;
    const option = document.createElement("button");
    option.type = "button";
    option.className = `model-option${isActive ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(isActive));
    const check = document.createElement("span");
    check.className = "model-option-check";
    check.textContent = isActive ? "✓" : "";
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
      if (model.provider !== activeProvider) await api.setProvider(model.provider);
      await api.setModel(model.id);
      activeModel = model.id;
      activeProvider = model.provider;
      modelMenu.hidden = true;
      modelPickerButton.setAttribute("aria-expanded", "false");
      await loadStatus();
    });
    modelOptions.appendChild(option);
  }
}

async function loadModelPicker() {
  try {
    const data = await api.modelsGrouped();
    availableModels = data.groups.flatMap((g) => g.models.map((m) => ({ ...m, provider: g.provider })));
    if (!activeModel) activeModel = data.current ?? "";
    if (!activeProvider) activeProvider = data.currentProvider ?? "";
    renderModelOptions();
  } catch {
    modelOptions.innerHTML = '<div class="model-empty">Could not load models</div>';
  }
}

// Called after switching provider (composer.js's /provider command) — the
// model picker's cached list belongs to whichever provider was active when
// it last loaded, so a provider switch needs a fresh fetch instead of just
// re-rendering the stale one.
export async function reloadModelPicker() {
  activeModel = "";
  activeProvider = "";
  await loadModelPicker();
  await loadStatus();
}

export function openModelMenu() {
  modelMenu.hidden = false;
  modelPickerButton.setAttribute("aria-expanded", "true");
  modelSearch.value = "";
  modelSearch.focus();
  renderModelOptions();
}

modelPickerButton.addEventListener("click", () => {
  if (modelMenu.hidden) openModelMenu();
  else {
    modelMenu.hidden = true;
    modelPickerButton.setAttribute("aria-expanded", "false");
  }
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
