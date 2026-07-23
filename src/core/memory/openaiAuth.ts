import { DatabaseSync } from "node:sqlite";

// Persists the ChatGPT OAuth token set obtained by the device-code login
// flow (src/core/llm/openaiAuth.ts) — one global row, not per-chat, since
// there's one ULTRON install and one ChatGPT login behind it, same scope as
// UserModelRegistry/HealthRegistry. Plaintext, consistent with the project's
// already-documented "no hardened secret management" security posture.

export interface OpenAITokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountEmail: string | null;
  updatedAt: string;
}

interface TokenRow {
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_email: string | null;
  updated_at: string;
}

function toTokenSet(row: TokenRow): OpenAITokenSet {
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    idToken: row.id_token,
    accountEmail: row.account_email,
    updatedAt: row.updated_at,
  };
}

export class OpenAIAuthRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS openai_oauth (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        id_token TEXT NOT NULL,
        account_email TEXT,
        updated_at TEXT NOT NULL
      )
    `);
  }

  get(): OpenAITokenSet | undefined {
    const row = this.db.prepare("SELECT * FROM openai_oauth WHERE id = 1").get() as TokenRow | undefined;
    return row ? toTokenSet(row) : undefined;
  }

  isAuthenticated(): boolean {
    return Boolean(this.get());
  }

  save(tokens: { accessToken: string; refreshToken: string; idToken: string; accountEmail: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO openai_oauth (id, access_token, refresh_token, id_token, account_email, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           id_token = excluded.id_token,
           account_email = excluded.account_email,
           updated_at = excluded.updated_at`,
      )
      .run(tokens.accessToken, tokens.refreshToken, tokens.idToken, tokens.accountEmail, new Date().toISOString());
  }

  clear(): void {
    this.db.prepare("DELETE FROM openai_oauth WHERE id = 1").run();
  }
}

let sharedRegistry: OpenAIAuthRegistry | undefined;

export function getOpenAIAuthRegistry(dbPath: string): OpenAIAuthRegistry {
  if (!sharedRegistry) sharedRegistry = new OpenAIAuthRegistry(dbPath);
  return sharedRegistry;
}
