import { api } from "./api.js";
import { state } from "./store.js";

const modelLabel = document.getElementById("model-label");
const contextLabel = document.getElementById("context-label");
const contextFill = document.getElementById("context-fill");
const settingsModel = document.getElementById("settings-model");
const settingsToolCount = document.getElementById("settings-tool-count");

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
