import { config, PROVIDER_CYCLE, type LlmProvider } from "../../config.js";
import { getOpenAIAuthRegistry } from "../memory/openaiAuth.js";
import { getValidAuth, codexAuthHeaders, CHATGPT_CODEX_BASE_URL } from "./openaiAuth.js";

// Shared by the local CLI (src/interfaces/cli/index.ts), the web server
// (src/interfaces/web/server.ts, which the remote CLI and Telegram's /model
// both go through) — one place that knows how to enumerate/enrich models
// for whichever provider is asked about, instead of three near-identical
// copies of the NVIDIA /models fetch + modelcard scrape that used to live
// inline in each interface.

export interface ModelInfo {
  id: string;
  contextWindowTokens?: number;
  provider?: LlmProvider;
}

async function fetchNvidiaModels(): Promise<ModelInfo[]> {
  const baseUrl = config.nemotronBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${config.nvidiaApiKey}` },
  });
  if (!response.ok) throw new Error(`NVIDIA returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: { id?: unknown; max_model_len?: unknown; max_context_length?: unknown }[];
  };
  return (payload.data ?? [])
    .map((model) => {
      if (typeof model.id !== "string" || !model.id) return undefined;
      const rawContext = model.max_model_len ?? model.max_context_length;
      const contextWindowTokens =
        typeof rawContext === "number"
          ? rawContext
          : typeof rawContext === "string" && /^\d+$/.test(rawContext)
            ? Number(rawContext)
            : undefined;
      return {
        id: model.id,
        ...(contextWindowTokens && Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0
          ? { contextWindowTokens }
          : {}),
      };
    })
    .filter((model): model is ModelInfo => Boolean(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// DeepSeek's API doesn't need live discovery — the account only ever exposes
// these two chat models, unlike NVIDIA NIM's large, frequently-changing
// catalog behind /v1/models.
function deepseekModels(): ModelInfo[] {
  return [
    { id: "deepseek-v4-flash", contextWindowTokens: 128_000 },
    { id: "deepseek-v4-pro", contextWindowTokens: 128_000 },
  ];
}

async function fetchGroqModels(): Promise<ModelInfo[]> {
  const baseUrl = config.groqBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${config.groqApiKey}` },
  });
  if (!response.ok) throw new Error(`Groq returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: { id?: unknown; active?: unknown; context_window?: unknown; output_modalities?: unknown; supported_features?: unknown }[];
  };
  return (payload.data ?? [])
    .filter((model) => {
      // Groq's catalog also lists TTS/vision/safety-only models ULTRON's
      // tool-calling loop can't use — keep only active, text-out models
      // that declare function-calling support.
      const outputs = Array.isArray(model.output_modalities) ? model.output_modalities : [];
      const features = Array.isArray(model.supported_features) ? model.supported_features : [];
      return model.active !== false && outputs.includes("text") && features.includes("tools") && typeof model.id === "string";
    })
    .map((model) => ({
      id: model.id as string,
      ...(typeof model.context_window === "number" && model.context_window > 0
        ? { contextWindowTokens: model.context_window }
        : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// The ChatGPT-account-scoped Codex backend exposes its own /models list
// (confirmed against openai/codex's own test fixtures), same live-discovery
// shape as NVIDIA/Groq rather than a hardcoded list like DeepSeek's two
// fixed models.
async function fetchOpenAIModels(): Promise<ModelInfo[]> {
  const { accessToken, accountId } = await getValidAuth(getOpenAIAuthRegistry(config.databasePath));
  const response = await fetch(`${CHATGPT_CODEX_BASE_URL}/models`, {
    headers: { Accept: "application/json", ...codexAuthHeaders(accessToken, accountId) },
  });
  if (!response.ok) throw new Error(`ChatGPT Codex backend returned HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: { id?: unknown; context_window?: unknown }[] } | { models?: { id?: unknown; context_window?: unknown }[] };
  const list = "data" in payload ? payload.data : "models" in payload ? payload.models : undefined;
  return (list ?? [])
    .map((model) => {
      if (typeof model.id !== "string" || !model.id) return undefined;
      return {
        id: model.id,
        ...(typeof model.context_window === "number" && model.context_window > 0 ? { contextWindowTokens: model.context_window } : {}),
      };
    })
    .filter((model): model is ModelInfo => Boolean(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchProviderModels(provider: LlmProvider): Promise<ModelInfo[]> {
  if (provider === "deepseek") return deepseekModels();
  if (provider === "groq") return fetchGroqModels();
  if (provider === "openai") return fetchOpenAIModels();
  return fetchNvidiaModels();
}

// The active provider's models only — used where only one provider's list
// makes sense (CLI/web/Telegram's initial context-window lookup at
// startup, and after a /provider switch).
export async function listAvailableModels(): Promise<ModelInfo[]> {
  return fetchProviderModels(config.provider);
}

export interface GroupedModels {
  provider: LlmProvider;
  models: ModelInfo[];
}

// All four providers' catalogs, tagged and grouped in a fixed order — what
// /model actually shows now, so switching providers is a side effect of
// picking a model rather than a separate step. A provider with no API key
// configured (deepseek/groq) or no ChatGPT login yet (openai) contributes an
// empty group instead of failing the whole listing.
export async function listModelsByProvider(): Promise<GroupedModels[]> {
  return Promise.all(
    PROVIDER_CYCLE.map(async (provider): Promise<GroupedModels> => {
      if (provider === "deepseek" && !config.deepseekApiKey) return { provider, models: [] };
      if (provider === "groq" && !config.groqApiKey) return { provider, models: [] };
      if (provider === "openai" && !getOpenAIAuthRegistry(config.databasePath).isAuthenticated()) return { provider, models: [] };
      try {
        const models = await fetchProviderModels(provider);
        return { provider, models: models.map((model) => ({ ...model, provider })) };
      } catch {
        return { provider, models: [] };
      }
    }),
  );
}

const modelContextCache = new Map<string, number | undefined>();

// NVIDIA's hosted NIM /v1/models omits max_model_len for most models — the
// public model card on build.nvidia.com states the same context length in
// prose (e.g. "1M context" / "128,000 tokens"), so this scrapes that as a
// fallback. Not applicable to DeepSeek/Groq — neither has such a catalog to
// scrape, and both already give a context figure directly in their listing.
export async function resolveModelContext<T extends ModelInfo>(model: T): Promise<T> {
  if (model.contextWindowTokens) return model;
  if ((model.provider ?? config.provider) !== "nvidia") return model;
  if (modelContextCache.has(model.id)) {
    const contextWindowTokens = modelContextCache.get(model.id);
    return contextWindowTokens ? { ...model, contextWindowTokens } : model;
  }

  try {
    const modelPath = model.id.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`https://build.nvidia.com/${modelPath}/modelcard`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const contextMatch = html.match(
      /(?:([\d][\d,.]*)\s*(million|[kKmM])\s*[- ]?token(?:s)?\s*context|context(?: window| length)?[^\d]{0,40}([\d][\d,.]*)\s*(million|[kKmM])?\s*token(?:s)?)/i,
    );
    const value = contextMatch?.[1] ?? contextMatch?.[3];
    const unit = (contextMatch?.[2] ?? contextMatch?.[4] ?? "").toLowerCase();
    if (!value) {
      modelContextCache.set(model.id, undefined);
      return model;
    }
    const numeric = Number(value.replace(/,/g, ""));
    const multiplier = unit === "million" || unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
    const contextWindowTokens = numeric * multiplier;
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
      modelContextCache.set(model.id, undefined);
      return model;
    }
    modelContextCache.set(model.id, contextWindowTokens);
    return { ...model, contextWindowTokens };
  } catch {
    modelContextCache.set(model.id, undefined);
    return model;
  }
}
