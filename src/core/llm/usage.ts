import { config } from "../../config.js";
import { getUsageRegistry, type UsageKind } from "../memory/usage.js";

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  elapsedSeconds: number;
}

// "deepseek-ai/deepseek-v4-flash" -> "deepseek-v4-flash".
export function shortModelLabel(model: string): string {
  return model.split("/").pop() ?? model;
}

export function estimateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * config.pricePerMillionInputTokens +
    (outputTokens / 1_000_000) * config.pricePerMillionOutputTokens
  );
}

// e.g. "deepseek-v4-flash | 7,688 in | 303 out | 10s | $0.14"
export function formatTurnStats(usage: TurnUsage): string {
  const cost = estimateCost(usage.inputTokens, usage.outputTokens);
  const seconds = Math.max(0, Math.round(usage.elapsedSeconds));
  return `${shortModelLabel(usage.model)} | ${usage.inputTokens.toLocaleString()} in | ${usage.outputTokens.toLocaleString()} out | ${seconds}s | $${cost.toFixed(2)}`;
}

// Logs one LLM call to the persistent usage_log table (see
// src/core/memory/usage.ts) — the single place every interface (CLI, web,
// Telegram) and every cheap separate call (narrator.ts, goalJudge.ts,
// userModelExtractor.ts, visionAnalyzer.ts) reports through, so the web
// UI's "Tokens" page reflects every request instead of only whatever the
// current turn's stats line last showed. Never throws — a broken usage
// write must not break the actual reply.
export function recordUsage(
  kind: UsageKind,
  chatId: string | null,
  model: string,
  inputTokens: number,
  outputTokens: number,
  elapsedMs: number,
  // Vision calls (visionAnalyzer.ts) always run on NVIDIA regardless of
  // config.provider (see CLAUDE.md — no vision equivalent on DeepSeek/Groq),
  // so they need to override the provider tag instead of inheriting
  // whichever chat provider happens to be active.
  provider: string = config.provider,
): void {
  try {
    getUsageRegistry(config.databasePath).record({
      provider,
      model,
      kind,
      chatId,
      inputTokens,
      outputTokens,
      elapsedMs,
      costUsd: estimateCost(inputTokens, outputTokens),
    });
  } catch {
    // Usage tracking is best-effort — never let it interrupt a reply.
  }
}
