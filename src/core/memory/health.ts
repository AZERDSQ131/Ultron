import { DatabaseSync } from "node:sqlite";
import { computeActivityScore, computeRecoveryScore } from "../health/scoring.js";
import { detectAnomalies } from "../health/trends.js";

// Health data ingested from daily exports (Health Export Kit or similar) —
// global like UserModelRegistry, not scoped per chat: health is a fact about
// the person, not about a conversation. Never purged: health_days keeps the
// full raw payload forever alongside flat extracted metrics used for fast
// range/aggregate queries (see health_query in src/core/tools/health.ts) and
// baseline recomputation. Stays in the same SQLite file as everything else,
// so it lives only wherever ULTRON's own database file lives (the Jetson).

export type HealthMetric =
  | "steps"
  | "activeEnergyKcal"
  | "distanceKm"
  | "exerciseMinutes"
  | "flightsClimbed"
  | "workoutCount"
  | "restingHR"
  | "walkingHR"
  | "sleepDurationSec"
  | "sleepAsleepSec"
  | "sleepAwakeSec"
  | "hrvAvg"
  | "respiratoryRateAvg";

export interface HealthDay {
  date: string;
  timezone: string;
  steps: number | null;
  activeEnergyKcal: number | null;
  distanceKm: number | null;
  exerciseMinutes: number | null;
  flightsClimbed: number | null;
  workoutCount: number | null;
  restingHR: number | null;
  walkingHR: number | null;
  sleepDurationSec: number | null;
  sleepAsleepSec: number | null;
  sleepAwakeSec: number | null;
  hrvAvg: number | null;
  respiratoryRateAvg: number | null;
  rawJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface HealthBaseline {
  metric: string;
  windowDays: number;
  mean: number;
  stddev: number;
  sampleCount: number;
  updatedAt: string;
}

export interface HealthProfile {
  birthdate: string | null;
  sleepTargetHours: number;
}

export interface HealthRecords {
  bestSleepNight?: { date: string; durationSec: number };
  lowestRestingHR?: { date: string; value: number };
  mostSteps?: { date: string; value: number };
  // Consecutive most-recent days at or above the personal 30-day steps
  // baseline — "typical for you" activity, not an absolute step count.
  currentActivityStreakDays: number;
}

export interface HealthSleepDebt {
  deficitHours: number;
  daysCounted: number;
}

interface HealthDayRow {
  date: string;
  timezone: string;
  steps: number | null;
  active_energy_kcal: number | null;
  distance_km: number | null;
  exercise_minutes: number | null;
  flights_climbed: number | null;
  workout_count: number | null;
  resting_hr: number | null;
  walking_hr: number | null;
  sleep_duration_sec: number | null;
  sleep_asleep_sec: number | null;
  sleep_awake_sec: number | null;
  hrv_avg: number | null;
  respiratory_rate_avg: number | null;
  raw_json: string;
  created_at: string;
  updated_at: string;
}

function toHealthDay(row: HealthDayRow): HealthDay {
  return {
    date: row.date,
    timezone: row.timezone,
    steps: row.steps,
    activeEnergyKcal: row.active_energy_kcal,
    distanceKm: row.distance_km,
    exerciseMinutes: row.exercise_minutes,
    flightsClimbed: row.flights_climbed,
    workoutCount: row.workout_count,
    restingHR: row.resting_hr,
    walkingHR: row.walking_hr,
    sleepDurationSec: row.sleep_duration_sec,
    sleepAsleepSec: row.sleep_asleep_sec,
    sleepAwakeSec: row.sleep_awake_sec,
    hrvAvg: row.hrv_avg,
    respiratoryRateAvg: row.respiratory_rate_avg,
    rawJson: row.raw_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Loose shape of a Health Export Kit-style payload — only the fields this
// module reads are typed; everything else in the payload is preserved
// as-is in raw_json but not otherwise interpreted.
export interface HealthExportPayload {
  activity?: {
    daily?: Array<{
      date: string;
      steps?: number;
      activeEnergyKcal?: number;
      distanceKm?: number;
      exerciseMinutes?: number;
      flightsClimbed?: number;
      workoutCount?: number;
    }>;
    timeZone?: string;
  };
  additional?: {
    heart?: {
      daily?: Array<{ date: string; values?: { restingHR?: number; walkingHR?: number } }>;
    };
  };
  sleep?: {
    sessions?: Array<{
      start: string;
      end: string;
      asleepSec?: number;
      awakeSec?: number;
      durationSec?: number;
      vitals?: {
        hrvSDNN?: { avg?: number };
        respiratoryRate?: { avg?: number };
      };
    }>;
  };
  meta?: { timeZone?: string; rangeEnd?: string; rangeStart?: string };
}

const WINDOWS = [7, 30, 90];

const METRIC_COLUMNS: Record<HealthMetric, string> = {
  steps: "steps",
  activeEnergyKcal: "active_energy_kcal",
  distanceKm: "distance_km",
  exerciseMinutes: "exercise_minutes",
  flightsClimbed: "flights_climbed",
  workoutCount: "workout_count",
  restingHR: "resting_hr",
  walkingHR: "walking_hr",
  sleepDurationSec: "sleep_duration_sec",
  sleepAsleepSec: "sleep_asleep_sec",
  sleepAwakeSec: "sleep_awake_sec",
  hrvAvg: "hrv_avg",
  respiratoryRateAvg: "respiratory_rate_avg",
};

// A sleep session's "date" is the local calendar day it ended on (the night
// of 07-19 into 07-20 is attributed to 07-20's wake-up), matching how the
// export's own daily activity buckets are anchored to local time. Sessions
// in the sample payload use "MM-dd HH:mm:ss" with no year (anchored at the
// export's rangeEnd, per its own meta.notes) — a full ISO string is used
// as-is when given instead.
function localDateFromSessionEnd(end: string, referenceYear: string): string {
  const isoMatch = end.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const shortMatch = end.match(/^(\d{2})-(\d{2})/);
  if (shortMatch) return `${referenceYear}-${shortMatch[1]}-${shortMatch[2]}`;
  return end;
}

// A day with only e.g. workoutCount: 0 and nothing else (a same-day
// "partial" entry an export commonly includes for "today so far") must
// never be picked as the scoring/anomaly/bio-age reference day just
// because it has the latest date key — that would silently show a hollow
// neutral score instead of the most recent day with actual signal. Falls
// back to the literal last day (even if empty) only if nothing in the
// range has any real data, so callers always get a date to anchor on.
export function pickLatestWithData(days: HealthDay[]): HealthDay | undefined {
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day.steps !== null || day.restingHR !== null || day.hrvAvg !== null || day.sleepDurationSec !== null) return day;
  }
  return days[days.length - 1];
}

export class HealthRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_days (
        date TEXT PRIMARY KEY,
        timezone TEXT NOT NULL,
        steps INTEGER,
        active_energy_kcal REAL,
        distance_km REAL,
        exercise_minutes REAL,
        flights_climbed INTEGER,
        workout_count INTEGER,
        resting_hr REAL,
        walking_hr REAL,
        sleep_duration_sec INTEGER,
        sleep_asleep_sec INTEGER,
        sleep_awake_sec INTEGER,
        hrv_avg REAL,
        respiratory_rate_avg REAL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_baselines (
        metric TEXT NOT NULL,
        window_days INTEGER NOT NULL,
        mean REAL NOT NULL,
        stddev REAL NOT NULL,
        sample_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (metric, window_days)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        birthdate TEXT,
        sleep_target_hours REAL NOT NULL DEFAULT 8
      )
    `);
  }

  // Merges a day's metrics into whatever is already stored for that date —
  // a payload only ever covers a rolling window (see the sample export's
  // rangeStart/rangeEnd), so a later ingest with a narrower window must not
  // null out fields a previous ingest already populated for the same date.
  private upsertDay(date: string, timezone: string, patch: Partial<HealthDayRow>, rawJson: string): void {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT * FROM health_days WHERE date = ?").get(date) as HealthDayRow | undefined;
    const merged: Omit<HealthDayRow, "date"> = {
      timezone,
      steps: patch.steps ?? existing?.steps ?? null,
      active_energy_kcal: patch.active_energy_kcal ?? existing?.active_energy_kcal ?? null,
      distance_km: patch.distance_km ?? existing?.distance_km ?? null,
      exercise_minutes: patch.exercise_minutes ?? existing?.exercise_minutes ?? null,
      flights_climbed: patch.flights_climbed ?? existing?.flights_climbed ?? null,
      workout_count: patch.workout_count ?? existing?.workout_count ?? null,
      resting_hr: patch.resting_hr ?? existing?.resting_hr ?? null,
      walking_hr: patch.walking_hr ?? existing?.walking_hr ?? null,
      sleep_duration_sec: patch.sleep_duration_sec ?? existing?.sleep_duration_sec ?? null,
      sleep_asleep_sec: patch.sleep_asleep_sec ?? existing?.sleep_asleep_sec ?? null,
      sleep_awake_sec: patch.sleep_awake_sec ?? existing?.sleep_awake_sec ?? null,
      hrv_avg: patch.hrv_avg ?? existing?.hrv_avg ?? null,
      respiratory_rate_avg: patch.respiratory_rate_avg ?? existing?.respiratory_rate_avg ?? null,
      raw_json: rawJson,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO health_days (date, timezone, steps, active_energy_kcal, distance_km, exercise_minutes,
           flights_climbed, workout_count, resting_hr, walking_hr, sleep_duration_sec, sleep_asleep_sec,
           sleep_awake_sec, hrv_avg, respiratory_rate_avg, raw_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           timezone = excluded.timezone,
           steps = excluded.steps,
           active_energy_kcal = excluded.active_energy_kcal,
           distance_km = excluded.distance_km,
           exercise_minutes = excluded.exercise_minutes,
           flights_climbed = excluded.flights_climbed,
           workout_count = excluded.workout_count,
           resting_hr = excluded.resting_hr,
           walking_hr = excluded.walking_hr,
           sleep_duration_sec = excluded.sleep_duration_sec,
           sleep_asleep_sec = excluded.sleep_asleep_sec,
           sleep_awake_sec = excluded.sleep_awake_sec,
           hrv_avg = excluded.hrv_avg,
           respiratory_rate_avg = excluded.respiratory_rate_avg,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        date,
        merged.timezone,
        merged.steps,
        merged.active_energy_kcal,
        merged.distance_km,
        merged.exercise_minutes,
        merged.flights_climbed,
        merged.workout_count,
        merged.resting_hr,
        merged.walking_hr,
        merged.sleep_duration_sec,
        merged.sleep_asleep_sec,
        merged.sleep_awake_sec,
        merged.hrv_avg,
        merged.respiratory_rate_avg,
        merged.raw_json,
        merged.created_at,
        merged.updated_at,
      );
  }

  // Parses one Health Export Kit-shaped payload and upserts every day it
  // covers. Returns the list of dates touched, for the caller to report
  // back (e.g. the ingest endpoint's response body).
  ingest(payload: HealthExportPayload): { dates: string[] } {
    const timezone = payload.activity?.timeZone ?? payload.meta?.timeZone ?? "UTC";
    const referenceYear = (payload.meta?.rangeEnd ?? payload.meta?.rangeStart ?? new Date().toISOString()).slice(0, 4);
    const rawJson = JSON.stringify(payload);
    const touched = new Set<string>();

    for (const day of payload.activity?.daily ?? []) {
      this.upsertDay(
        day.date,
        timezone,
        {
          steps: day.steps ?? null,
          active_energy_kcal: day.activeEnergyKcal ?? null,
          distance_km: day.distanceKm ?? null,
          exercise_minutes: day.exerciseMinutes ?? null,
          flights_climbed: day.flightsClimbed ?? null,
          workout_count: day.workoutCount ?? null,
        },
        rawJson,
      );
      touched.add(day.date);
    }

    for (const day of payload.additional?.heart?.daily ?? []) {
      this.upsertDay(
        day.date,
        timezone,
        {
          resting_hr: day.values?.restingHR ?? null,
          walking_hr: day.values?.walkingHR ?? null,
        },
        rawJson,
      );
      touched.add(day.date);
    }

    for (const session of payload.sleep?.sessions ?? []) {
      const date = localDateFromSessionEnd(session.end, referenceYear);
      this.upsertDay(
        date,
        timezone,
        {
          sleep_duration_sec: session.durationSec ?? null,
          sleep_asleep_sec: session.asleepSec ?? null,
          sleep_awake_sec: session.awakeSec ?? null,
          hrv_avg: session.vitals?.hrvSDNN?.avg ?? null,
          respiratory_rate_avg: session.vitals?.respiratoryRate?.avg ?? null,
        },
        rawJson,
      );
      touched.add(date);
    }

    this.recomputeBaselines();
    return { dates: [...touched].sort() };
  }

  getDay(date: string): HealthDay | undefined {
    const row = this.db.prepare("SELECT * FROM health_days WHERE date = ?").get(date) as HealthDayRow | undefined;
    return row ? toHealthDay(row) : undefined;
  }

  getRange(from: string, to: string): HealthDay[] {
    const rows = this.db
      .prepare("SELECT * FROM health_days WHERE date >= ? AND date <= ? ORDER BY date ASC")
      .all(from, to) as unknown as HealthDayRow[];
    return rows.map(toHealthDay);
  }

  hasData(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM health_days").get() as { c: number };
    return row.c > 0;
  }

  getBaseline(metric: HealthMetric, windowDays: number): HealthBaseline | undefined {
    const row = this.db
      .prepare("SELECT * FROM health_baselines WHERE metric = ? AND window_days = ?")
      .get(metric, windowDays) as
      | { metric: string; window_days: number; mean: number; stddev: number; sample_count: number; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      metric: row.metric,
      windowDays: row.window_days,
      mean: row.mean,
      stddev: row.stddev,
      sampleCount: row.sample_count,
      updatedAt: row.updated_at,
    };
  }

  // Recomputes mean/stddev for every tracked metric over the 7/30/90-day
  // windows ending today, from whatever history is already stored — cheap
  // enough to run after every ingest rather than on a separate schedule.
  recomputeBaselines(): void {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    for (const windowDays of WINDOWS) {
      const from = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const days = this.getRange(from, today);
      for (const metric of Object.keys(METRIC_COLUMNS) as HealthMetric[]) {
        const values = days
          .map((d) => (d as unknown as Record<string, number | null>)[metric])
          .filter((v): v is number => v !== null && v !== undefined);
        if (values.length === 0) continue;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
        const stddev = Math.sqrt(variance);
        this.db
          .prepare(
            `INSERT INTO health_baselines (metric, window_days, mean, stddev, sample_count, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(metric, window_days) DO UPDATE SET
               mean = excluded.mean, stddev = excluded.stddev, sample_count = excluded.sample_count, updated_at = excluded.updated_at`,
          )
          .run(metric, windowDays, mean, stddev, values.length, now);
      }
    }
  }

  // Deterministic (no LLM) summary of the last 7 days for the <health_recent>
  // system-prompt block — same role as UserModelRegistry.renderForPrompt.
  // Undefined when there's nothing recorded yet, so the block is omitted
  // entirely rather than injected empty.
  renderForPrompt(): string | undefined {
    if (!this.hasData()) return undefined;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const days = this.getRange(from, to);
    if (!days.length) return undefined;
    const lines = days.map((day) => {
      const parts: string[] = [];
      if (day.steps !== null) parts.push(`${day.steps} steps`);
      if (day.sleepDurationSec !== null) parts.push(`${(day.sleepDurationSec / 3600).toFixed(1)}h sleep`);
      if (day.restingHR !== null) parts.push(`resting HR ${day.restingHR}`);
      if (day.hrvAvg !== null) parts.push(`HRV ${day.hrvAvg}ms`);
      return `- ${day.date}: ${parts.length ? parts.join(", ") : "no data"}`;
    });

    const latest = pickLatestWithData(days)!;
    const getBaseline30 = (metric: HealthMetric) => this.getBaseline(metric, 30);
    const recovery = computeRecoveryScore(latest, getBaseline30);
    const activity = computeActivityScore(latest, getBaseline30);
    const anomalies = detectAnomalies(latest, getBaseline30);
    const streak = this.getRecords().currentActivityStreakDays;

    const extras: string[] = [`Recovery score ${recovery}/100, activity score ${activity}/100 (${latest.date}, vs personal 30-day baseline).`];
    if (streak > 0) extras.push(`Current activity streak: ${streak} day${streak === 1 ? "" : "s"} at or above your normal activity level.`);
    if (anomalies.length) extras.push(`Notable: ${anomalies[0].message}`);

    return `${lines.join("\n")}\n${extras.join("\n")}`;
  }

  // Scans the full history (never purged, so this can grow — acceptable for
  // a personal daily-export dataset where even years of data is a few
  // thousand rows) for all-time bests and the current activity streak.
  getRecords(): HealthRecords {
    const all = this.getRange("0000-01-01", "9999-12-31");
    let bestSleepNight: HealthRecords["bestSleepNight"];
    let lowestRestingHR: HealthRecords["lowestRestingHR"];
    let mostSteps: HealthRecords["mostSteps"];
    for (const day of all) {
      if (day.sleepDurationSec !== null && (!bestSleepNight || day.sleepDurationSec > bestSleepNight.durationSec)) {
        bestSleepNight = { date: day.date, durationSec: day.sleepDurationSec };
      }
      if (day.restingHR !== null && (!lowestRestingHR || day.restingHR < lowestRestingHR.value)) {
        lowestRestingHR = { date: day.date, value: day.restingHR };
      }
      if (day.steps !== null && (!mostSteps || day.steps > mostSteps.value)) {
        mostSteps = { date: day.date, value: day.steps };
      }
    }
    const stepsBaseline = this.getBaseline("steps", 30);
    let currentActivityStreakDays = 0;
    if (stepsBaseline) {
      for (let i = all.length - 1; i >= 0; i--) {
        const day = all[i];
        if (day.steps !== null && day.steps >= stepsBaseline.mean) currentActivityStreakDays++;
        else break;
      }
    }
    return { bestSleepNight, lowestRestingHR, mostSteps, currentActivityStreakDays };
  }

  // Cumulative shortfall against health_profile.sleep_target_hours over the
  // last N days (default 7) — only counts days with recorded sleep, so a
  // gap in the export doesn't get misread as a zero-hour night.
  getSleepDebt(days = 7): HealthSleepDebt {
    const profile = this.getProfile();
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const range = this.getRange(from, to);
    let deficitSec = 0;
    let daysCounted = 0;
    for (const day of range) {
      if (day.sleepDurationSec === null) continue;
      daysCounted++;
      deficitSec += Math.max(0, profile.sleepTargetHours * 3600 - day.sleepDurationSec);
    }
    return { deficitHours: deficitSec / 3600, daysCounted };
  }

  getProfile(): HealthProfile {
    const row = this.db.prepare("SELECT * FROM health_profile WHERE id = 1").get() as
      | { birthdate: string | null; sleep_target_hours: number }
      | undefined;
    return { birthdate: row?.birthdate ?? null, sleepTargetHours: row?.sleep_target_hours ?? 8 };
  }

  // Partial<HealthProfile> callers (e.g. health_set_profile, which only sets
  // whichever field the user mentioned) commonly pass an object literal
  // like { birthdate: undefined, sleepTargetHours: 7.5 } — the key is
  // PRESENT with value undefined, not omitted, so a naive `{...current,
  // ...profile}` spread would overwrite an already-set birthdate with
  // undefined (and node:sqlite rejects binding undefined outright). Only
  // fields explicitly provided as non-undefined override the current value.
  setProfile(profile: Partial<HealthProfile>): HealthProfile {
    const current = this.getProfile();
    const merged: HealthProfile = {
      birthdate: profile.birthdate !== undefined ? profile.birthdate : current.birthdate,
      sleepTargetHours: profile.sleepTargetHours !== undefined ? profile.sleepTargetHours : current.sleepTargetHours,
    };
    this.db
      .prepare(
        `INSERT INTO health_profile (id, birthdate, sleep_target_hours) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET birthdate = excluded.birthdate, sleep_target_hours = excluded.sleep_target_hours`,
      )
      .run(merged.birthdate, merged.sleepTargetHours);
    return merged;
  }
}

// Tiny ASCII/Unicode sparkline for a metric over a short range (e.g. the
// CLI's /health command) — shared here rather than duplicated per
// interface since Telegram's /health can use the same block characters.
const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";
export function sparkline(values: (number | null)[]): string {
  const present = values.filter((v): v is number => v !== null);
  if (!present.length) return "";
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  return values
    .map((v) => {
      if (v === null) return " ";
      const index = Math.min(SPARK_BLOCKS.length - 1, Math.floor(((v - min) / span) * (SPARK_BLOCKS.length - 1)));
      return SPARK_BLOCKS[index];
    })
    .join("");
}

let sharedRegistry: HealthRegistry | undefined;

export function getHealthRegistry(dbPath: string): HealthRegistry {
  if (!sharedRegistry) sharedRegistry = new HealthRegistry(dbPath);
  return sharedRegistry;
}
