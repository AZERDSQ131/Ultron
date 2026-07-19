import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../../config.js";
import { getHealthRegistry, pickLatestWithData, type HealthDay, type HealthExportPayload, type HealthMetric } from "../memory/health.js";
import { computeActivityScore, computeRecoveryScore } from "../health/scoring.js";
import { detectAnomalies } from "../health/trends.js";
import { estimateBiologicalAge } from "../health/bioAge.js";
import { narrateHealth } from "../health/narrator.js";
import { exportHealthHistory } from "../health/export.js";

const health = getHealthRegistry(config.databasePath);

const METRICS: HealthMetric[] = [
  "steps",
  "activeEnergyKcal",
  "distanceKm",
  "exerciseMinutes",
  "flightsClimbed",
  "workoutCount",
  "restingHR",
  "walkingHR",
  "sleepDurationSec",
  "sleepAsleepSec",
  "sleepAwakeSec",
  "hrvAvg",
  "respiratoryRateAvg",
];

function chronoAgeYears(birthdate: string): number {
  const ms = Date.now() - new Date(birthdate).getTime();
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

function formatDay(day: HealthDay): string {
  const parts: string[] = [];
  if (day.steps !== null) parts.push(`${day.steps} steps`);
  if (day.activeEnergyKcal !== null) parts.push(`${day.activeEnergyKcal} kcal active`);
  if (day.exerciseMinutes !== null) parts.push(`${day.exerciseMinutes} min exercise`);
  if (day.restingHR !== null) parts.push(`resting HR ${day.restingHR}`);
  if (day.walkingHR !== null) parts.push(`walking HR ${day.walkingHR}`);
  if (day.sleepDurationSec !== null) parts.push(`sleep ${(day.sleepDurationSec / 3600).toFixed(1)}h`);
  if (day.hrvAvg !== null) parts.push(`HRV ${day.hrvAvg}ms`);
  if (day.respiratoryRateAvg !== null) parts.push(`resp. rate ${day.respiratoryRateAvg}brpm`);
  return `${day.date}: ${parts.length ? parts.join(", ") : "no data"}`;
}

// This tool is the manual/fallback ingestion path (see
// POST /api/health-data/ingest in the web server for the primary, default
// path meant to be called by an external health-export app/shortcut) — for
// pasting an export directly into a chat when that automation isn't set up
// or hasn't run yet.
export const healthIngest = tool(
  async ({ json }: { json: string }) => {
    let payload: HealthExportPayload;
    try {
      payload = JSON.parse(json) as HealthExportPayload;
    } catch {
      return "error: not valid JSON";
    }
    const { dates } = health.ingest(payload);
    if (!dates.length) return "Parsed the payload but found no recognizable activity/heart/sleep data to store.";
    return `Stored health data for: ${dates.join(", ")}.`;
  },
  {
    name: "health_ingest",
    description:
      "Manually ingest a health export payload (activity/sleep/heart JSON, e.g. from Health Export Kit) pasted " +
      "directly into the conversation. Prefer this only when the automatic ingestion endpoint isn't set up — " +
      "pass the raw JSON exactly as received, unmodified.",
    schema: z.object({ json: z.string().describe("The raw health export JSON payload, exactly as received.") }),
  },
);

export const healthQuery = tool(
  async ({ from, to, metric, aggregate }: { from: string; to: string; metric?: HealthMetric; aggregate?: "raw" | "avg" | "sum" | "min" | "max" | "trend" | "scores" }) => {
    const days = health.getRange(from, to);
    if (!days.length) return `No health data recorded between ${from} and ${to}.`;

    const mode = aggregate ?? "raw";
    if (mode === "raw") {
      return days.map(formatDay).join("\n");
    }

    if (mode === "scores") {
      const latest = pickLatestWithData(days)!;
      const getBaseline30 = (m: HealthMetric) => health.getBaseline(m, 30);
      const recovery = computeRecoveryScore(latest, getBaseline30);
      const activity = computeActivityScore(latest, getBaseline30);
      const anomalies = detectAnomalies(latest, getBaseline30);
      const records = health.getRecords();
      const sleepDebt = health.getSleepDebt();
      const lines = [
        `Recovery score ${recovery}/100, activity score ${activity}/100 for ${latest.date} (vs personal 30-day baseline).`,
        `Current activity streak: ${records.currentActivityStreakDays} day(s) at or above your normal activity level.`,
        `Sleep debt (last 7 days): ${sleepDebt.deficitHours.toFixed(1)}h deficit across ${sleepDebt.daysCounted} recorded night(s).`,
        records.bestSleepNight ? `Best sleep on record: ${(records.bestSleepNight.durationSec / 3600).toFixed(1)}h on ${records.bestSleepNight.date}.` : undefined,
        records.lowestRestingHR ? `Lowest resting HR on record: ${records.lowestRestingHR.value} on ${records.lowestRestingHR.date}.` : undefined,
        ...anomalies.map((a) => `Anomaly (${a.severity}): ${a.message}`),
      ].filter((line): line is string => Boolean(line));

      const profile = health.getProfile();
      if (profile.birthdate) {
        const sleepEfficiencyPct =
          latest.sleepAsleepSec !== null && latest.sleepDurationSec !== null && latest.sleepDurationSec > 0
            ? (latest.sleepAsleepSec / latest.sleepDurationSec) * 100
            : null;
        const bioAge = estimateBiologicalAge(chronoAgeYears(profile.birthdate), {
          restingHR: latest.restingHR,
          hrvAvg: latest.hrvAvg,
          sleepEfficiencyPct,
          activityScore: activity,
        });
        lines.push(`Estimated biological age: ${bioAge.age} (wellness estimate, not medical) — ${bioAge.explanation.join(" ")}`);
      }

      return lines.join("\n");
    }

    if (!metric) return "error: 'metric' is required when 'aggregate' is not 'raw' or 'scores'.";
    const values = days.map((d) => d[metric]).filter((v): v is number => v !== null);
    if (!values.length) return `No values for ${metric} between ${from} and ${to}.`;

    if (mode === "trend") {
      const rangeAvg = values.reduce((a, b) => a + b, 0) / values.length;
      const baseline = health.getBaseline(metric, 30);
      if (!baseline) return `${metric} averaged ${rangeAvg.toFixed(1)} over ${from}..${to} (no 30-day baseline yet to compare against).`;
      const delta = rangeAvg - baseline.mean;
      const direction = delta > 0 ? "above" : delta < 0 ? "below" : "at";
      return `${metric} averaged ${rangeAvg.toFixed(1)} over ${from}..${to}, ${Math.abs(delta).toFixed(1)} ${direction} the 30-day baseline (${baseline.mean.toFixed(1)}).`;
    }

    const result =
      mode === "avg"
        ? values.reduce((a, b) => a + b, 0) / values.length
        : mode === "sum"
          ? values.reduce((a, b) => a + b, 0)
          : mode === "min"
            ? Math.min(...values)
            : Math.max(...values);
    return `${mode}(${metric}) over ${from}..${to} = ${result.toFixed(1)} (${values.length} day${values.length === 1 ? "" : "s"} with data).`;
  },
  {
    name: "health_query",
    description:
      "Query stored health data (activity, sleep, heart rate, HRV, respiratory rate) over a date range. Use " +
      "aggregate 'raw' (default) to list each day, 'scores' for the recovery/activity score, current anomalies, " +
      "activity streak, sleep debt, and personal records as of the range's last day, or 'avg'/'sum'/'min'/'max'/" +
      "'trend' with a specific metric to summarize the range — 'trend' also compares the range's average against " +
      "the personal 30-day baseline.",
    schema: z.object({
      from: z.string().describe("Start date, YYYY-MM-DD, inclusive."),
      to: z.string().describe("End date, YYYY-MM-DD, inclusive."),
      metric: z.enum(METRICS as [HealthMetric, ...HealthMetric[]]).optional().describe("Required unless aggregate is 'raw' or 'scores'."),
      aggregate: z.enum(["raw", "avg", "sum", "min", "max", "trend", "scores"]).optional().describe("Defaults to 'raw'."),
    }),
  },
);

// Sets personal profile fields the model learns conversationally (e.g. the
// user states their birthdate) rather than through a form — birthdate is
// required for the biological-age estimate in health_query's 'scores' mode
// (see bioAge.ts); sleep target feeds getSleepDebt().
export const healthSetProfile = tool(
  async ({ birthdate, sleepTargetHours }: { birthdate?: string; sleepTargetHours?: number }) => {
    if (birthdate === undefined && sleepTargetHours === undefined) return "error: provide at least one of birthdate or sleepTargetHours.";
    const profile = health.setProfile({ birthdate, sleepTargetHours });
    return `Profile updated: birthdate=${profile.birthdate ?? "unset"}, sleepTargetHours=${profile.sleepTargetHours}.`;
  },
  {
    name: "health_set_profile",
    description:
      "Set personal health profile fields: birthdate (enables the biological-age estimate) and/or sleepTargetHours " +
      "(used for sleep-debt tracking). Call this when the user tells you their birthdate or a sleep goal in " +
      "conversation, not preemptively.",
    schema: z.object({
      birthdate: z.string().optional().describe("YYYY-MM-DD."),
      sleepTargetHours: z.number().optional().describe("Personal nightly sleep target in hours."),
    }),
  },
);

function periodToRange(period: "week" | "month" | undefined, from?: string, to?: string): { from: string; to: string } {
  if (from && to) return { from, to };
  const days = period === "month" ? 30 : 7;
  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

// On-demand only — never auto-scheduled by this tool itself (the user
// explicitly did not want a default recurring push). If they want one
// later, the existing schedule_task tool can call this without any new
// code.
export const healthReport = tool(
  async ({ period, from, to }: { period?: "week" | "month"; from?: string; to?: string }) => {
    const range = periodToRange(period, from, to);
    const days = health.getRange(range.from, range.to);
    if (!days.length) return `No health data recorded between ${range.from} and ${range.to}.`;

    const latest = pickLatestWithData(days)!;
    const getBaseline30 = (m: HealthMetric) => health.getBaseline(m, 30);
    const recovery = computeRecoveryScore(latest, getBaseline30);
    const activity = computeActivityScore(latest, getBaseline30);
    const anomalies = detectAnomalies(latest, getBaseline30);
    const records = health.getRecords();
    const sleepDebt = health.getSleepDebt();

    const profile = health.getProfile();
    const bioAge = profile.birthdate
      ? estimateBiologicalAge(chronoAgeYears(profile.birthdate), {
          restingHR: latest.restingHR,
          hrvAvg: latest.hrvAvg,
          sleepEfficiencyPct:
            latest.sleepAsleepSec !== null && latest.sleepDurationSec !== null && latest.sleepDurationSec > 0
              ? (latest.sleepAsleepSec / latest.sleepDurationSec) * 100
              : null,
          activityScore: activity,
        })
      : undefined;

    return await narrateHealth({ from: range.from, to: range.to, recovery, activity, anomalies, records, sleepDebt, bioAge });
  },
  {
    name: "health_report",
    description:
      "Generate a short, on-demand coach-style narration of recent health data (recovery/activity trend, notable " +
      "anomalies, records, biological age if set up). Only call this when the user actually asks for a summary/" +
      "report — never push one proactively or on a schedule by default.",
    schema: z.object({
      period: z.enum(["week", "month"]).optional().describe("Shorthand for the last 7 or 30 days. Ignored if from/to given."),
      from: z.string().optional().describe("Explicit start date YYYY-MM-DD, overrides period."),
      to: z.string().optional().describe("Explicit end date YYYY-MM-DD, overrides period."),
    }),
  },
);

export const healthExport = tool(
  async ({ path }: { path?: string }) => {
    const resolved = await exportHealthHistory(health, path ?? "health-history.md");
    return `Health history exported to ${resolved}.`;
  },
  {
    name: "health_export",
    description: "Export the full health history to a Markdown file (e.g. to share with a doctor). Only call when explicitly asked.",
    schema: z.object({ path: z.string().optional().describe("Relative or absolute path; defaults to health-history.md next to the database.") }),
  },
);
