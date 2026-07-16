import { DatabaseSync } from "node:sqlite";

// Per-chat to-do list, the same shape as Claude Code's own TodoWrite tool:
// a short, flat list the model keeps current while working through a long
// task, so both the model (via todo_read) and the user (the web UI's right
// panel) can see current progress without scrolling the transcript.
//
// One row per chat_id, storing the whole list as a JSON blob — same
// rationale as ChatRegistry (see chats.ts): a chat's list is always read
// and replaced as a whole (todo_write overwrites it entirely), never
// queried by individual item, so there's no need for a child table.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoRow {
  chat_id: string;
  items: string;
  updated_at: string;
}

export class TodoRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        chat_id TEXT PRIMARY KEY,
        items TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  get(chatId: string): TodoItem[] {
    const row = this.db.prepare("SELECT * FROM todos WHERE chat_id = ?").get(chatId) as TodoRow | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.items) as TodoItem[];
    } catch {
      return [];
    }
  }

  set(chatId: string, items: TodoItem[]): TodoItem[] {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO todos (chat_id, items, updated_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at",
      )
      .run(chatId, JSON.stringify(items), now);
    return items;
  }
}

let sharedRegistry: TodoRegistry | undefined;

export function getTodoRegistry(dbPath: string): TodoRegistry {
  if (!sharedRegistry) sharedRegistry = new TodoRegistry(dbPath);
  return sharedRegistry;
}
