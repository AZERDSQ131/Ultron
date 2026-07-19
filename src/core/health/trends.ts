import type { HealthDay, HealthMetric } from "../memory/health.js";
import type { BaselineLookup } from "./scoring.js";

export interface HealthAnomaly {
  metric: HealthMetric | "composite";
  severity: "notable" | "significant";
  message: string;
}

// Any metric more than this many personal standard deviations from its own
// 30-day baseline is "notable"; past this it's "significant". Personal, not
// population-relative — see scoring.ts's zScore for why that distinction
// matters here.
const NOTABLE_Z = 1.5;
const SIGNIFICANT_Z = 2.5;

function zScore(value: number | null, mean: number | undefined, stddev: number | undefined): number | undefined {
  if (value === null || mean === undefined || stddev === undefined || stddev === 0) return undefined;
  return (value - mean) / stddev;
}

// Flags days that stand out against the person's own recent history — never
// against a population norm. Includes a composite "possible illness/
// overtraining onset" flag: resting HR up, HRV down, and respiratory rate up
// all at once is the classic early pattern for both, showing 1-2 days before
// symptoms typically would.
export function detectAnomalies(day: HealthDay, getBaseline: BaselineLookup): HealthAnomaly[] {
  const anomalies: HealthAnomaly[] = [];

  const restingHRBaseline = getBaseline("restingHR");
  const hrvBaseline = getBaseline("hrvAvg");
  const respBaseline = getBaseline("respiratoryRateAvg");
  const sleepBaseline = getBaseline("sleepDurationSec");
  const stepsBaseline = getBaseline("steps");

  const restingHRz = zScore(day.restingHR, restingHRBaseline?.mean, restingHRBaseline?.stddev);
  const hrvZ = zScore(day.hrvAvg, hrvBaseline?.mean, hrvBaseline?.stddev);
  const respZ = zScore(day.respiratoryRateAvg, respBaseline?.mean, respBaseline?.stddev);
  const sleepZ = zScore(day.sleepDurationSec, sleepBaseline?.mean, sleepBaseline?.stddev);
  const stepsZ = zScore(day.steps, stepsBaseline?.mean, stepsBaseline?.stddev);

  if (restingHRz !== undefined && hrvZ !== undefined && respZ !== undefined && restingHRz > NOTABLE_Z && hrvZ < -NOTABLE_Z && respZ > NOTABLE_Z) {
    anomalies.push({
      metric: "composite",
      severity: "significant",
      message: `Resting HR up, HRV down, and respiratory rate up all at once on ${day.date} — the classic early pattern for oncoming illness or overtraining, often 1-2 days before it's felt.`,
    });
  }

  if (restingHRz !== undefined && Math.abs(restingHRz) >= NOTABLE_Z) {
    anomalies.push({
      metric: "restingHR",
      severity: Math.abs(restingHRz) >= SIGNIFICANT_Z ? "significant" : "notable",
      message: `Resting HR ${day.restingHR} on ${day.date} is ${restingHRz > 0 ? "above" : "below"} the personal baseline (z=${restingHRz.toFixed(1)}).`,
    });
  }
  if (hrvZ !== undefined && Math.abs(hrvZ) >= NOTABLE_Z) {
    anomalies.push({
      metric: "hrvAvg",
      severity: Math.abs(hrvZ) >= SIGNIFICANT_Z ? "significant" : "notable",
      message: `HRV ${day.hrvAvg}ms on ${day.date} is ${hrvZ > 0 ? "above" : "below"} the personal baseline (z=${hrvZ.toFixed(1)}).`,
    });
  }
  if (sleepZ !== undefined && sleepZ <= -NOTABLE_Z) {
    anomalies.push({
      metric: "sleepDurationSec",
      severity: sleepZ <= -SIGNIFICANT_Z ? "significant" : "notable",
      message: `Sleep on ${day.date} (${((day.sleepDurationSec ?? 0) / 3600).toFixed(1)}h) is well below the personal baseline (z=${sleepZ.toFixed(1)}).`,
    });
  }
  if (stepsZ !== undefined && Math.abs(stepsZ) >= SIGNIFICANT_Z) {
    anomalies.push({
      metric: "steps",
      severity: "significant",
      message: `Steps ${day.steps} on ${day.date} is far ${stepsZ > 0 ? "above" : "below"} the personal baseline (z=${stepsZ.toFixed(1)}).`,
    });
  }

  return anomalies;
}
