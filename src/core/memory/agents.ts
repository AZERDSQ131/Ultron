import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface Agent { id: string; name: string; description: string; instructions: string; createdAt: string; updatedAt: string; }
export interface Schedule { id: string; agentId: string | null; name: string; instruction: string; cron: string; timezone: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; lastRunChatId: string | null; createdAt: string; }

type AgentRow = { id: string; name: string; description: string; instructions: string; created_at: string; updated_at: string };
type ScheduleRow = { id: string; agent_id: string | null; name: string; instruction: string; cron: string; timezone: string; enabled: number; next_run_at: string | null; last_run_at: string | null; last_run_chat_id?: string | null; created_at: string };
const agent = (r: AgentRow): Agent => ({ id: r.id, name: r.name, description: r.description, instructions: r.instructions, createdAt: r.created_at, updatedAt: r.updated_at });
const schedule = (r: ScheduleRow): Schedule => ({ id: r.id, agentId: r.agent_id, name: r.name, instruction: r.instruction, cron: r.cron, timezone: r.timezone, enabled: Boolean(r.enabled), nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastRunChatId: r.last_run_chat_id ?? null, createdAt: r.created_at });

export class AgentRegistry {
  private db: DatabaseSync;
  constructor(private readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, agent_id TEXT, name TEXT NOT NULL, instruction TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Paris', enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, last_run_at TEXT, last_run_chat_id TEXT, created_at TEXT NOT NULL)`);
    try { this.db.exec("ALTER TABLE schedules ADD COLUMN last_run_chat_id TEXT"); } catch { /* already migrated */ }
  }
  listAgents(): Agent[] { return (this.db.prepare("SELECT * FROM agents ORDER BY updated_at DESC").all() as unknown as AgentRow[]).map(agent); }
  getAgent(id: string): Agent | undefined { const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined; return r && agent(r); }
  createAgent(name: string, description = "", instructions = ""): Agent { const now = new Date().toISOString(); const a = { id: randomUUID(), name, description, instructions, createdAt: now, updatedAt: now }; this.db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?)").run(a.id, a.name, a.description, a.instructions, a.createdAt, a.updatedAt); return a; }
  updateAgent(id: string, fields: Partial<Pick<Agent, "name" | "description" | "instructions">>): Agent | undefined { const current = this.getAgent(id); if (!current) return; const a = { ...current, ...fields, updatedAt: new Date().toISOString() }; this.db.prepare("UPDATE agents SET name=?, description=?, instructions=?, updated_at=? WHERE id=?").run(a.name, a.description, a.instructions, a.updatedAt, id); return a; }
  deleteAgent(id: string): void { this.db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(id); this.db.prepare("DELETE FROM agents WHERE id = ?").run(id); }
  listSchedules(): Schedule[] { return (this.db.prepare("SELECT * FROM schedules ORDER BY enabled DESC, next_run_at").all() as unknown as ScheduleRow[]).map(schedule); }
  getDueSchedules(now = new Date()): Schedule[] { return (this.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now.toISOString()) as unknown as ScheduleRow[]).map(schedule); }
  createSchedule(input: { agentId?: string | null; name: string; instruction: string; cron: string; timezone?: string; nextRunAt?: Date }): Schedule { const now = new Date().toISOString(); const next = input.nextRunAt ?? nextCronDate(input.cron, new Date()); const s = { id: randomUUID(), agentId: input.agentId ?? null, name: input.name, instruction: input.instruction, cron: input.cron, timezone: input.timezone ?? "Europe/Paris", enabled: true, nextRunAt: next.toISOString(), lastRunAt: null, lastRunChatId: null, createdAt: now }; this.db.prepare("INSERT INTO schedules (id, agent_id, name, instruction, cron, timezone, enabled, next_run_at, last_run_at, last_run_chat_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?)").run(s.id, s.agentId, s.name, s.instruction, s.cron, s.timezone, s.nextRunAt, s.createdAt); return s; }
  setScheduleEnabled(id: string, enabled: boolean): void { this.db.prepare("UPDATE schedules SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id); }
  markRun(id: string, now = new Date()): void { const s = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id) as ScheduleRow | undefined; if (!s) return; const next = s.cron === "@once" ? null : nextCronDate(s.cron, now).toISOString(); this.db.prepare("UPDATE schedules SET last_run_at=?, next_run_at=? WHERE id=?").run(now.toISOString(), next, id); }
  setLastRunChat(id: string, chatId: string): void { this.db.prepare("UPDATE schedules SET last_run_chat_id=? WHERE id=?").run(chatId, id); }
  deleteSchedule(id: string): void { this.db.prepare("DELETE FROM schedules WHERE id=?").run(id); }
  cleanupCompletedSchedules(now = new Date(), retentionMs = 60 * 60 * 1000): void {
    this.db.prepare("DELETE FROM schedules WHERE cron='@once' AND last_run_at IS NOT NULL AND last_run_at <= ?").run(new Date(now.getTime() - retentionMs).toISOString());
  }
}

function fieldMatches(field: string, value: number): boolean { return field === "*" || field.split(",").some((part) => part.startsWith("*/") ? value % Number(part.slice(2)) === 0 : Number(part) === value); }
export function nextCronDate(expression: string, from: Date): Date { const fields = expression.trim().split(/\s+/); if (fields.length !== 5) throw new Error("cron must use five fields: minute hour day month weekday"); const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1); for (let i = 0; i < 366 * 24 * 60; i++, d.setMinutes(d.getMinutes() + 1)) { if (fieldMatches(fields[0], d.getMinutes()) && fieldMatches(fields[1], d.getHours()) && fieldMatches(fields[2], d.getDate()) && fieldMatches(fields[3], d.getMonth() + 1) && fieldMatches(fields[4], d.getDay())) return new Date(d); } throw new Error("cron has no occurrence within one year"); }
