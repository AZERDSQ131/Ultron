import { DatabaseSync } from "node:sqlite";

export type ChatEventKind = "human" | "ai";
export type ChatEventSource = "cli" | "telegram";

export interface ChatEvent {
  id: number;
  chatId: string;
  kind: ChatEventKind;
  source: ChatEventSource;
  content: string;
  createdAt: string;
}

interface ChatEventRow {
  id: number;
  chat_id: string;
  kind: ChatEventKind;
  source: ChatEventSource;
  content: string;
  created_at: string;
}

function toEvent(row: ChatEventRow): ChatEvent {
  return { id: row.id, chatId: row.chat_id, kind: row.kind, source: row.source, content: row.content, createdAt: row.created_at };
}

export class ChatEventRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_chat_events_chat_id_id ON chat_events (chat_id, id)");
  }

  append(chatId: string, kind: ChatEventKind, source: ChatEventSource, content: string): ChatEvent {
    const result = this.db
      .prepare("INSERT INTO chat_events (chat_id, kind, source, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(chatId, kind, source, content, new Date().toISOString());
    return this.get(Number(result.lastInsertRowid)) as ChatEvent;
  }

  listAfter(chatId: string, afterId: number): ChatEvent[] {
    const rows = this.db
      .prepare("SELECT id, chat_id, kind, source, content, created_at FROM chat_events WHERE chat_id = ? AND id > ? ORDER BY id ASC")
      .all(chatId, afterId) as unknown as ChatEventRow[];
    return rows.map(toEvent);
  }

  latestId(chatId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM chat_events WHERE chat_id = ?").get(chatId) as { id: number };
    return row.id;
  }

  private get(id: number): ChatEvent | undefined {
    const row = this.db
      .prepare("SELECT id, chat_id, kind, source, content, created_at FROM chat_events WHERE id = ?")
      .get(id) as ChatEventRow | undefined;
    return row ? toEvent(row) : undefined;
  }
}

let sharedRegistry: ChatEventRegistry | undefined;

export function getChatEventRegistry(dbPath: string): ChatEventRegistry {
  if (!sharedRegistry) sharedRegistry = new ChatEventRegistry(dbPath);
  return sharedRegistry;
}
