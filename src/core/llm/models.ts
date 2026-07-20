import { config } from "../../config.js";

// Shared by the local CLI (src/interfaces/cli/index.ts), the web server
// (src/interfaces/web/server.ts, which the remote CLI and Telegram's /model
// both go through) — one place that knows how to enumerate/enrich models
// for whichever provider (config.provider) is currently active, instead of
// three near-identical copies of the NVIDIA /models fetch + modelcard
// scrape that used to live inline in each interface.

export interface ModelInfo {
  id: string;
  contextWindowTokens?: number;
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

export async function listAvailableModels(): Promise<ModelInfo[]> {
  return config.provider === "deepseek" ? deepseekModels() : fetchNvidiaModels();
}

const modelContextCache = new Map<string, number | undefined>();

// NVIDIA's hosted NIM /v1/models omits max_model_len for most models — the
// public model card on build.nvidia.com states the same context length in
// prose (e.g. "1M context" / "128,000 tokens"), so this scrapes that as a
// fallback. Not applicable to DeepSeek (no such catalog to scrape, and the
// two models above are already given a context figure directly).
export async function resolveModelContext(model: ModelInfo): Promise<ModelInfo> {
  if (model.contextWindowTokens) return model;
  if (config.provider === "deepseek") return model;
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
