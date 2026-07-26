import type { LlmProvider } from "../../config.js";

export type ThinkingMode = "off" | "default" | "low" | "medium" | "high" | "max" | "full";

export interface ReasoningProfile {
  provider: LlmProvider;
  model: string;
  supported: boolean;
  options: ThinkingMode[];
  defaultMode: ThinkingMode | null;
  note: string;
}

const nvidiaProfileCache = new Map<string, ReasoningProfile>();

function profile(provider: LlmProvider, model: string, options: ThinkingMode[], defaultMode: ThinkingMode | null, note: string): ReasoningProfile {
  return { provider, model, supported: options.some((option) => option !== "off"), options, defaultMode, note };
}

function groqProfile(model: string): ReasoningProfile {
  if (/^openai\/gpt-oss(?:-safeguard)?-/.test(model) || /^openai\/gpt-oss-(?:20b|120b)$/.test(model)) {
    return profile("groq", model, ["low", "medium", "high"], "medium", "Groq expose reasoning_effort: low, medium ou high pour ce modèle.");
  }
  if (model === "qwen/qwen3.6-27b") {
    return profile("groq", model, ["off", "default"], "default", "Groq expose reasoning_effort: none ou default pour ce modèle.");
  }
  return profile("groq", model, ["off"], null, "Ce modèle Groq ne déclare pas de réglage de raisonnement dans son endpoint /models.");
}

async function nvidiaProfile(model: string): Promise<ReasoningProfile> {
  const cached = nvidiaProfileCache.get(model);
  if (cached) return cached;
  try {
    const modelPath = model.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`https://build.nvidia.com/${modelPath}/modelcard`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = (await response.text()).replaceAll(/\\(["'])/g, "$1");
    const declaresThinking = /enable_thinking|reasoning_effort|chat_template_kwargs[^\n]{0,240}thinking/i.test(html);
    const options: ThinkingMode[] = ["off"];
    if (declaresThinking) {
      if (/low_effort/i.test(html)) options.push("low");
      const supportsHigh = /reasoning_effort[\s\S]{0,240}["']high["']/i.test(html);
      if (supportsHigh) options.push("high");
      if (/reasoning_effort.{0,240}\bmax\b/i.test(html)) options.push("max");
      if (options.length === 1) options.push("default");
    }
    const result = declaresThinking
      ? profile("nvidia", model, options, options.includes("high") ? "high" : options[1], "Options détectées dans la fiche NVIDIA de ce modèle.")
      : profile("nvidia", model, ["off"], null, "La fiche NVIDIA ne déclare pas de réglage de raisonnement configurable pour ce modèle.");
    nvidiaProfileCache.set(model, result);
    return result;
  } catch {
    const result = /reasoning/i.test(model)
      ? profile("nvidia", model, ["off", "high"], "high", "Fiche NVIDIA indisponible; profil déduit du nom du modèle reasoning.")
      : profile("nvidia", model, ["off"], null, "Impossible de vérifier la fiche NVIDIA; aucun réglage n’est proposé par prudence.");
    nvidiaProfileCache.set(model, result);
    return result;
  }
}

export async function getReasoningProfile(provider: LlmProvider, model: string): Promise<ReasoningProfile> {
  if (provider === "deepseek") return profile(provider, model, ["off", "high", "max"], "high", "DeepSeek expose thinking désactivé, ou reasoning_effort high/max.");
  if (provider === "groq") return groqProfile(model);
  if (provider === "nvidia") return nvidiaProfile(model);
  return profile(provider, model, ["off"], null, "L’endpoint OpenAI/Codex ne déclare pas de réglage de raisonnement vérifiable pour ce modèle.");
}

export function normalizeThinkingMode(mode: ThinkingMode): ThinkingMode {
  return mode === "full" ? "high" : mode;
}
