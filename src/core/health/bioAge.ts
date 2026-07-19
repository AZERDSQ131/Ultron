// A transparent, explainable "biological age" estimate — explicitly NOT a
// clinical or medically validated score. There is no peer-reviewed formula
// for this available to the project, so the constants below are a
// documented, adjustable heuristic in the same spirit as popular wellness/
// fitness-tracker "fitness age" calculators: each factor nudges the
// chronological age up or down by a capped amount, and every nudge is
// reported in `explanation` so nothing is a black box. Treat the output as
// a motivational/wellness signal, never as a health diagnosis.

export interface BioAgeMetrics {
  restingHR: number | null;
  hrvAvg: number | null;
  sleepEfficiencyPct: number | null; // asleepSec / durationSec * 100
  activityScore: number | null; // 0-100, from computeActivityScore (Phase 2)
}

export interface BioAgeResult {
  age: number;
  explanation: string[];
}

// Rough population reference points for an adult, not this person's own
// baseline — the whole point of a biological-age estimate is to compare
// against people in general, unlike the personal-baseline z-scores used
// elsewhere in this module (scoring.ts, trends.ts).
const REF_RESTING_HR = 65; // bpm
const REF_HRV = 40; // ms
const REF_SLEEP_EFFICIENCY = 90; // %
const REF_ACTIVITY_SCORE = 50; // "typical for this person" per computeActivityScore

function clampContribution(value: number, cap: number): number {
  return Math.min(cap, Math.max(-cap, value));
}

export function estimateBiologicalAge(chronologicalAgeYears: number, metrics: BioAgeMetrics): BioAgeResult {
  const explanation: string[] = [];
  let ageDelta = 0;

  if (metrics.restingHR !== null) {
    const contribution = clampContribution((metrics.restingHR - REF_RESTING_HR) / 5, 8);
    ageDelta += contribution;
    if (Math.abs(contribution) >= 0.3) {
      explanation.push(
        `Resting HR ${metrics.restingHR} vs a ~${REF_RESTING_HR} reference: ${contribution > 0 ? "+" : ""}${contribution.toFixed(1)} years.`,
      );
    }
  }

  if (metrics.hrvAvg !== null) {
    const contribution = clampContribution(-(metrics.hrvAvg - REF_HRV) / 5, 8);
    ageDelta += contribution;
    if (Math.abs(contribution) >= 0.3) {
      explanation.push(
        `HRV ${metrics.hrvAvg}ms vs a ~${REF_HRV}ms reference: ${contribution > 0 ? "+" : ""}${contribution.toFixed(1)} years.`,
      );
    }
  }

  if (metrics.sleepEfficiencyPct !== null) {
    const contribution = clampContribution(-(metrics.sleepEfficiencyPct - REF_SLEEP_EFFICIENCY) / 5, 4);
    ageDelta += contribution;
    if (Math.abs(contribution) >= 0.3) {
      explanation.push(
        `Sleep efficiency ${metrics.sleepEfficiencyPct.toFixed(0)}% vs a ~${REF_SLEEP_EFFICIENCY}% reference: ${contribution > 0 ? "+" : ""}${contribution.toFixed(1)} years.`,
      );
    }
  }

  if (metrics.activityScore !== null) {
    const contribution = clampContribution(-(metrics.activityScore - REF_ACTIVITY_SCORE) / 20, 3);
    ageDelta += contribution;
    if (Math.abs(contribution) >= 0.3) {
      explanation.push(
        `Activity score ${metrics.activityScore}/100 vs your own typical level: ${contribution > 0 ? "+" : ""}${contribution.toFixed(1)} years.`,
      );
    }
  }

  const age = Math.max(0, chronologicalAgeYears + ageDelta);
  if (!explanation.length) explanation.push("Not enough data yet to pull the estimate away from your chronological age.");
  return { age: Math.round(age * 10) / 10, explanation };
}
