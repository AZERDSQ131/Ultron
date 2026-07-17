import { DatabaseSync } from "node:sqlite";

// Per-chat /goal state (CLI-only feature — see src/core/goalJudge.ts and the
// CLI's driveGoalLoop). Same one-row-per-chat shape as TodoRegistry
// (todos.ts): a goal is always read and replaced as a whole, never queried
// by field, so there's no need for a child table.
//
// Only one goal can exist per chat at a time, mirroring OpenClaw's /goal:
// starting a new one while another is active/paused is a caller error, not
// a silent overwrite — see the CLI's "a goal is already active" guard.

export type GoalStatus = "active" | "paused" | "complete" | "cleared";

export interface Goal {
  chatId: string;
  objective: string;
  status: GoalStatus;
  turnsUsed: number;
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
  // Set on pause ("blocked", "turn budget exhausted", ...) and on complete
  // ("done"). Null on a freshly (re)started active goal.
  lastVerdict: string | null;
  lastReason: string | null;
}

interface GoalRow {
  chat_id: string;
  objective: string;
  status: string;
  turns_used: number;
  max_turns: number;
  created_at: string;
  updated_at: string;
  last_verdict: string | null;
  last_reason: string | null;
}

function toGoal(row: GoalRow): Goal {
  return {
    chatId: row.chat_id,
    objective: row.objective,
    status: row.status as GoalStatus,
    turnsUsed: row.turns_used,
    maxTurns: row.max_turns,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerdict: row.last_verdict,
    lastReason: row.last_reason,
  };
}

export class GoalRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        chat_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        turns_used INTEGER NOT NULL DEFAULT 0,
        max_turns INTEGER NOT NULL DEFAULT 20,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verdict TEXT,
        last_reason TEXT
      )
    `);
  }

  get(chatId: string): Goal | undefined {
    const row = this.db.prepare("SELECT * FROM goals WHERE chat_id = ?").get(chatId) as GoalRow | undefined;
    return row ? toGoal(row) : undefined;
  }

  // Starts a fresh goal, resetting turn count/verdict even if a row already
  // exists for this chat (a cleared/complete goal being replaced) — callers
  // are responsible for refusing this when an active/paused goal exists.
  set(chatId: string, objective: string, maxTurns: number): Goal {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO goals (chat_id, objective, status, turns_used, max_turns, created_at, updated_at, last_verdict, last_reason)
         VALUES (?, ?, 'active', 0, ?, ?, ?, NULL, NULL)
         ON CONFLICT(chat_id) DO UPDATE SET
           objective = excluded.objective, status = 'active', turns_used = 0, max_turns = excluded.max_turns,
           created_at = excluded.created_at, updated_at = excluded.updated_at, last_verdict = NULL, last_reason = NULL`,
      )
      .run(chatId, objective, maxTurns, now, now);
    return this.get(chatId)!;
  }

  recordTurn(chatId: string): void {
    this.db
      .prepare("UPDATE goals SET turns_used = turns_used + 1, updated_at = ? WHERE chat_id = ?")
      .run(new Date().toISOString(), chatId);
  }

  pause(chatId: string, reason: string): Goal | undefined {
    this.db
      .prepare("UPDATE goals SET status = 'paused', last_verdict = 'paused', last_reason = ?, updated_at = ? WHERE chat_id = ?")
      .run(reason, new Date().toISOString(), chatId);
    return this.get(chatId);
  }

  // Only resumes a paused goal — a cleared/complete/already-active goal has
  // nothing to resume, so callers get undefined and can message accordingly.
  // Resets turns_used to open a fresh turn-budget window, same rationale as
  // OpenClaw's goal resume: otherwise a goal paused for exhausting its
  // budget would immediately re-trip the same check on its very next
  // evaluation, making "/goal resume" a no-op for that pause reason.
  resume(chatId: string): Goal | undefined {
    const goal = this.get(chatId);
    if (!goal || goal.status !== "paused") return undefined;
    this.db
      .prepare("UPDATE goals SET status = 'active', turns_used = 0, last_verdict = NULL, last_reason = NULL, updated_at = ? WHERE chat_id = ?")
      .run(new Date().toISOString(), chatId);
    return this.get(chatId);
  }

  markDone(chatId: string, reason: string): void {
    this.db
      .prepare("UPDATE goals SET status = 'complete', last_verdict = 'done', last_reason = ?, updated_at = ? WHERE chat_id = ?")
      .run(reason, new Date().toISOString(), chatId);
  }

  clear(chatId: string): void {
    this.db.prepare("UPDATE goals SET status = 'cleared', updated_at = ? WHERE chat_id = ?").run(new Date().toISOString(), chatId);
  }
}

let sharedRegistry: GoalRegistry | undefined;

export function getGoalRegistry(dbPath: string): GoalRegistry {
  if (!sharedRegistry) sharedRegistry = new GoalRegistry(dbPath);
  return sharedRegistry;
}
