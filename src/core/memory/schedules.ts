import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface Schedule {
  id: string;
  name: string;
  instruction: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunChatId: string | null;
  createdAt: string;
}

type ScheduleRow = {
  id: string;
  name: string;
  instruction: string;
  cron: string;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_chat_id?: string | null;
  created_at: string;
};

const toSchedule = (row: ScheduleRow): Schedule => ({
  id: row.id,
  name: row.name,
  instruction: row.instruction,
  cron: row.cron,
  timezone: row.timezone,
  enabled: Boolean(row.enabled),
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  lastRunChatId: row.last_run_chat_id ?? null,
  createdAt: row.created_at,
});

export class ScheduleRegistry {
  private db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    // agent_id is intentionally retained in the existing SQLite schema as a
    // compatibility column. Schedules no longer have an Agent owner.
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT, name TEXT NOT NULL, instruction TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Paris', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_run_chat_id TEXT, created_at TEXT NOT NULL)`);
    try { this.db.exec("ALTER TABLE schedules ADD COLUMN last_run_chat_id TEXT"); } catch { /* already migrated */ }
  }

  listSchedules(): Schedule[] {
    return (this.db.prepare("SELECT id, name, instruction, cron, timezone, enabled, next_run_at, last_run_at, last_run_chat_id, created_at FROM schedules ORDER BY enabled DESC, next_run_at").all() as unknown as ScheduleRow[]).map(toSchedule);
  }

  getDueSchedules(now = new Date()): Schedule[] {
    return (this.db.prepare("SELECT id, name, instruction, cron, timezone, enabled, next_run_at, last_run_at, last_run_chat_id, created_at FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now.toISOString()) as unknown as ScheduleRow[]).map(toSchedule);
  }

  createSchedule(input: { name: string; instruction: string; cron: string; timezone?: string; nextRunAt?: Date }): Schedule {
    const now = new Date().toISOString();
    const next = input.nextRunAt ?? nextCronDate(input.cron, new Date());
    const schedule: Schedule = {
      id: randomUUID(),
      name: input.name,
      instruction: input.instruction,
      cron: input.cron,
      timezone: input.timezone ?? "Europe/Paris",
      enabled: true,
      nextRunAt: next.toISOString(),
      lastRunAt: null,
      lastRunChatId: null,
      createdAt: now,
    };
    this.db.prepare("INSERT INTO schedules (id, name, instruction, cron, timezone, enabled, next_run_at, last_run_at, last_run_chat_id, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?)").run(schedule.id, schedule.name, schedule.instruction, schedule.cron, schedule.timezone, schedule.nextRunAt, schedule.createdAt);
    return schedule;
  }

  setScheduleEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE schedules SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
  }

  markRun(id: string, now = new Date()): void {
    const row = this.db.prepare("SELECT cron FROM schedules WHERE id=?").get(id) as { cron?: string } | undefined;
    if (!row) return;
    const next = row.cron === "@once" ? null : nextCronDate(row.cron ?? "", now).toISOString();
    this.db.prepare("UPDATE schedules SET last_run_at=?, next_run_at=? WHERE id=?").run(now.toISOString(), next, id);
  }

  setLastRunChat(id: string, chatId: string): void {
    this.db.prepare("UPDATE schedules SET last_run_chat_id=? WHERE id=?").run(chatId, id);
  }

  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id=?").run(id);
  }

  cleanupCompletedSchedules(now = new Date(), retentionMs = 60 * 60 * 1000): void {
    this.db.prepare("DELETE FROM schedules WHERE cron='@once' AND last_run_at IS NOT NULL AND last_run_at <= ?").run(new Date(now.getTime() - retentionMs).toISOString());
  }
}

function fieldMatches(field: string, value: number): boolean {
  return field === "*" || field.split(",").some((part) => part.startsWith("*/") ? value % Number(part.slice(2)) === 0 : Number(part) === value);
}

export function nextCronDate(expression: string, from: Date): Date {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron must use five fields: minute hour day month weekday");
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++, date.setMinutes(date.getMinutes() + 1)) {
    if (fieldMatches(fields[0], date.getMinutes()) && fieldMatches(fields[1], date.getHours()) && fieldMatches(fields[2], date.getDate()) && fieldMatches(fields[3], date.getMonth() + 1) && fieldMatches(fields[4], date.getDay())) return new Date(date);
  }
  throw new Error("cron has no occurrence within one year");
}
