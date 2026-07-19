import { config } from "../../config.js";

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
