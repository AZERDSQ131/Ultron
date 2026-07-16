import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getCheckpointer } from "./checkpointer.js";

// Registry of chats — each row's `id` doubles as the LangGraph thread_id
// used against the SqliteSaver checkpointer, so a chat and its message
// history always live under the same key. Kept in its own table (its own
// DatabaseSync connection, same file) rather than folded into the
// checkpointer, since it's a different kind of data: display metadata for
// the sidebar, not conversation state.
//
// This is what lets a chat started or archived from the CLI show up and be
// resumed from the web UI's sidebar, and vice versa — both processes point
// at the same registry table in the same shared database file.

export const DEFAULT_CHAT_TITLE = "New chat";

// The CLI's original hardcoded thread_id, from before chats existed. Every
// entry point calls chats.ensure(LEGACY_CHAT_ID, ...) at startup so
// pre-existing history registers as a real chat instead of being orphaned.
export const LEGACY_CHAT_ID = "ultron-main";

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

function toChat(row: ChatRow): Chat {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return DEFAULT_CHAT_TITLE;
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
}

export class ChatRegistry {
  private db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  list(): Chat[] {
    const rows = this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all() as unknown as ChatRow[];
    return rows.map(toChat);
  }

  get(id: string): Chat | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
    return row ? toChat(row) : undefined;
  }

  create(title: string = DEFAULT_CHAT_TITLE): Chat {
    const now = new Date().toISOString();
    const chat: Chat = { id: randomUUID(), title, createdAt: now, updatedAt: now };
    this.db
      .prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(chat.id, chat.title, chat.createdAt, chat.updatedAt);
    return chat;
  }

  // Registers a thread_id that may already have checkpoint history (e.g.
  // the legacy "ultron-main" thread from before chats existed) without
  // overwriting it if it's already registered.
  ensure(id: string, title: string = DEFAULT_CHAT_TITLE): Chat {
    const existing = this.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const chat: Chat = { id, title, createdAt: now, updatedAt: now };
    this.db
      .prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(chat.id, chat.title, chat.createdAt, chat.updatedAt);
    return chat;
  }

  rename(id: string, title: string): void {
    this.db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), id);
  }

  touch(id: string): void {
    this.db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  // Called with the first human message of a chat; only takes effect while
  // the chat still has the placeholder title, so it never clobbers a name
  // the user picked deliberately.
  maybeAutoTitle(id: string, text: string): void {
    const chat = this.get(id);
    if (!chat || chat.title !== DEFAULT_CHAT_TITLE) return;
    this.rename(id, deriveTitle(text));
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    getCheckpointer(this.dbPath).deleteThread(id);
  }
}

let sharedRegistry: ChatRegistry | undefined;

export function getChatRegistry(dbPath: string): ChatRegistry {
  if (!sharedRegistry) sharedRegistry = new ChatRegistry(dbPath);
  return sharedRegistry;
}
