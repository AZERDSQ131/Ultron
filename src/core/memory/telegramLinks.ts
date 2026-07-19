import { DatabaseSync } from "node:sqlite";

// Which ULTRON chat a given Telegram chat currently points at. Kept
// separate from ChatRegistry because this pointer must be able to MOVE —
// /archive starts a fresh chat and repoints here, /chat and /resume repoint
// to an existing one — unlike the CLI's single hardcoded LEGACY_CHAT_ID or
// the deterministic ids used elsewhere. A Telegram chat has no
// chat-switching UI of its own, so this is the whole mechanism for it.

export class TelegramLinkRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_links (
        telegram_chat_id TEXT PRIMARY KEY,
        ultron_chat_id TEXT NOT NULL
      )
    `);
  }

  get(telegramChatId: number): string | undefined {
    const row = this.db
      .prepare("SELECT ultron_chat_id FROM telegram_links WHERE telegram_chat_id = ?")
      .get(String(telegramChatId)) as { ultron_chat_id: string } | undefined;
    return row?.ultron_chat_id;
  }

  list(): Array<{ telegramChatId: number; ultronChatId: string }> {
    const rows = this.db
      .prepare("SELECT telegram_chat_id, ultron_chat_id FROM telegram_links")
      .all() as Array<{ telegram_chat_id: string; ultron_chat_id: string }>;
    return rows.map((row) => ({ telegramChatId: Number(row.telegram_chat_id), ultronChatId: row.ultron_chat_id }));
  }

  set(telegramChatId: number, ultronChatId: string): void {
    this.db
      .prepare(
        `INSERT INTO telegram_links (telegram_chat_id, ultron_chat_id) VALUES (?, ?)
         ON CONFLICT(telegram_chat_id) DO UPDATE SET ultron_chat_id = excluded.ultron_chat_id`,
      )
      .run(String(telegramChatId), ultronChatId);
  }
}

let sharedRegistry: TelegramLinkRegistry | undefined;

export function getTelegramLinkRegistry(dbPath: string): TelegramLinkRegistry {
  if (!sharedRegistry) sharedRegistry = new TelegramLinkRegistry(dbPath);
  return sharedRegistry;
}
