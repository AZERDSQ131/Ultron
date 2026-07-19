import type { HealthBaseline, HealthDay, HealthMetric } from "../memory/health.js";

// Both scores are pure, deterministic functions over already-stored data —
// no LLM involved (see src/core/health/narrator.ts for the layer that turns
// numbers like these into prose). Everything is scored relative to the
// person's own 30-day baseline, not a population norm, so "resting HR +5"
// means something specific: 5 above what's normal for THIS person recently.

export type BaselineLookup = (metric: HealthMetric) => HealthBaseline | undefined;

// Standard-score of a day's value against its personal baseline. Undefined
// when either the day's value or the baseline is missing (not enough
// history yet, or this metric wasn't in today's export) — callers treat a
// missing z-score as "no adjustment", never as zero/neutral.
function zScore(value: number | null, baseline: HealthBaseline | undefined): number | undefined {
  if (value === null || !baseline || baseline.stddev === 0) return undefined;
  return (value - baseline.mean) / baseline.stddev;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// 0-100, centered on 50 ("typical for you"). A lower resting HR and higher
// HRV than usual raise it; a higher resting HR, shorter sleep, or elevated
// respiratory rate lower it. Weights are a simple, documented heuristic —
// not a validated clinical formula — chosen so no single metric alone can
// swing the score by more than ~25 points.
export function computeRecoveryScore(day: HealthDay, getBaseline: BaselineLookup): number {
  let score = 50;

  const restingHRz = zScore(day.restingHR, getBaseline("restingHR"));
  if (restingHRz !== undefined) score -= restingHRz * 8; // higher-than-usual resting HR hurts recovery

  const hrvZ = zScore(day.hrvAvg, getBaseline("hrvAvg"));
  if (hrvZ !== undefined) score += hrvZ * 8; // higher-than-usual HRV helps recovery

  const sleepZ = zScore(day.sleepDurationSec, getBaseline("sleepDurationSec"));
  if (sleepZ !== undefined) score += sleepZ * 6;

  const respZ = zScore(day.respiratoryRateAvg, getBaseline("respiratoryRateAvg"));
  if (respZ !== undefined) score -= respZ * 4;

  return Math.round(clamp(score, 0, 100));
}

// 0-100, same "50 = typical for you" centering, built from steps, active
// energy, and exercise minutes vs their own 30-day baselines.
export function computeActivityScore(day: HealthDay, getBaseline: BaselineLookup): number {
  let score = 50;

  const stepsZ = zScore(day.steps, getBaseline("steps"));
  if (stepsZ !== undefined) score += stepsZ * 10;

  const energyZ = zScore(day.activeEnergyKcal, getBaseline("activeEnergyKcal"));
  if (energyZ !== undefined) score += energyZ * 6;

  const exerciseZ = zScore(day.exerciseMinutes, getBaseline("exerciseMinutes"));
  if (exerciseZ !== undefined) score += exerciseZ * 6;

  return Math.round(clamp(score, 0, 100));
}
