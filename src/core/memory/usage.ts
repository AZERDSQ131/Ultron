import { DatabaseSync } from "node:sqlite";

// Every LLM call ULTRON makes, across every interface and every provider —
// the main chat turn (CLI/web/Telegram) as well as the cheap separate calls
// (narrator.ts, goalJudge.ts, userModelExtractor.ts, visionAnalyzer.ts) —
// logged here so the web UI's "Tokens" page (see usageView.js) can answer
// "how much am I actually using, on what, and on which provider" instead of
// only ever showing the current turn's stats line and then forgetting it.
// Global like UserModelRegistry/HealthRegistry, never purged.

export type UsageKind = "chat" | "narrator" | "goal_judge" | "user_model" | "vision";

export interface UsageEntry {
  provider: string;
  model: string;
  kind: UsageKind;
  chatId: string | null;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  costUsd: number;
}

export interface UsageRecord extends UsageEntry {
  id: number;
  createdAt: string;
}

interface UsageRow {
  id: number;
  created_at: string;
  provider: string;
  model: string;
  kind: string;
  chat_id: string | null;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
  cost_usd: number;
}

function toRecord(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    provider: row.provider,
    model: row.model,
    kind: row.kind as UsageKind,
    chatId: row.chat_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    elapsedMs: row.elapsed_ms,
    costUsd: row.cost_usd,
  };
}

export interface UsageBreakdownRow {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageDayRow {
  date: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageSummary {
  totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
  byProvider: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byKind: UsageBreakdownRow[];
  byDay: UsageDayRow[];
  recent: UsageRecord[];
}

export class UsageRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        kind TEXT NOT NULL,
        chat_id TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log (created_at)");
  }

  record(entry: UsageEntry): void {
    this.db
      .prepare(
        `INSERT INTO usage_log (created_at, provider, model, kind, chat_id, input_tokens, output_tokens, elapsed_ms, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        entry.provider,
        entry.model,
        entry.kind,
        entry.chatId,
        entry.inputTokens,
        entry.outputTokens,
        entry.elapsedMs,
        entry.costUsd,
      );
  }

  hasData(): boolean {
    const row = this.db.prepare("SELECT 1 FROM usage_log LIMIT 1").get();
    return row !== undefined;
  }

  // sinceDays = undefined means all-time.
  summary(sinceDays?: number, recentLimit = 50): UsageSummary {
    const since = sinceDays ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString() : undefined;
    const whereClause = since ? "WHERE created_at >= ?" : "";
    const params = since ? [since] : [];

    const totalsRow = this.db
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cost_usd),0) AS costUsd
         FROM usage_log ${whereClause}`,
      )
      .get(...params) as unknown as { requests: number; inputTokens: number; outputTokens: number; costUsd: number };

    const breakdown = (column: "provider" | "model" | "kind"): UsageBreakdownRow[] =>
      (
        this.db
          .prepare(
            `SELECT ${column} AS key, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cost_usd),0) AS costUsd
             FROM usage_log ${whereClause}
             GROUP BY ${column}
             ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`,
          )
          .all(...params) as unknown as { key: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number }[]
      ).map((r) => ({ key: r.key, requests: r.requests, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd }));

    const byDay = (
      this.db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cost_usd),0) AS costUsd
           FROM usage_log ${whereClause}
           GROUP BY date
           ORDER BY date ASC`,
        )
        .all(...params) as unknown as { date: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number }[]
    ).map((r) => ({ date: r.date, requests: r.requests, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd }));

    const recent = (
      this.db.prepare(`SELECT * FROM usage_log ${whereClause} ORDER BY id DESC LIMIT ?`).all(...params, recentLimit) as unknown as UsageRow[]
    ).map(toRecord);

    return {
      totals: totalsRow,
      byProvider: breakdown("provider"),
      byModel: breakdown("model"),
      byKind: breakdown("kind"),
      byDay,
      recent,
    };
  }
}

let sharedRegistry: UsageRegistry | undefined;

export function getUsageRegistry(dbPath: string): UsageRegistry {
  if (!sharedRegistry) sharedRegistry = new UsageRegistry(dbPath);
  return sharedRegistry;
}
