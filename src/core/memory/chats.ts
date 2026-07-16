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

// How the "tools" node in graph.ts decides whether a tool call runs
// immediately or waits for a human decision (see the interrupt() call in
// buildGraph's tools node):
//   - "bypass": every tool call runs immediately (the project's long-standing
//     default — see CLAUDE.md's "security intentionally minimal").
//   - "accept_edit": only tool calls whose declared scope is "destructive"
//     (see toolScopes in tools/index.ts) pause for approval.
//   - "manual": every tool call pauses for approval, regardless of scope.
export type SecurityMode = "bypass" | "accept_edit" | "manual";
const DEFAULT_SECURITY_MODE: SecurityMode = "bypass";

// The CLI's original hardcoded thread_id, from before chats existed. Every
// entry point calls chats.ensure(LEGACY_CHAT_ID, ...) at startup so
// pre-existing history registers as a real chat instead of being orphaned.
export const LEGACY_CHAT_ID = "ultron-main";

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  agentId: string | null;
  scheduleId: string | null;
  securityMode: SecurityMode;
}

interface ChatRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent_id?: string | null;
  schedule_id?: string | null;
  security_mode?: string | null;
}

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentId: row.agent_id ?? null,
    scheduleId: row.schedule_id ?? null,
    securityMode: (row.security_mode as SecurityMode | null) ?? DEFAULT_SECURITY_MODE,
  };
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
    try { this.db.exec("ALTER TABLE chats ADD COLUMN agent_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE chats ADD COLUMN schedule_id TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE chats ADD COLUMN security_mode TEXT"); } catch { /* already migrated */ }
  }

  list(): Chat[] {
    const rows = this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all() as unknown as ChatRow[];
    return rows.map(toChat);
  }

  get(id: string): Chat | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
    return row ? toChat(row) : undefined;
  }

  create(title: string = DEFAULT_CHAT_TITLE, agentId: string | null = null, scheduleId: string | null = null): Chat {
    const now = new Date().toISOString();
    const chat: Chat = { id: randomUUID(), title, createdAt: now, updatedAt: now, agentId, scheduleId, securityMode: DEFAULT_SECURITY_MODE };
    this.db
      .prepare("INSERT INTO chats (id, title, created_at, updated_at, agent_id, schedule_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chat.id, chat.title, chat.createdAt, chat.updatedAt, chat.agentId, chat.scheduleId);
    return chat;
  }

  // Registers a thread_id that may already have checkpoint history (e.g.
  // the legacy "ultron-main" thread from before chats existed) without
  // overwriting it if it's already registered.
  ensure(id: string, title: string = DEFAULT_CHAT_TITLE): Chat {
    const existing = this.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const chat: Chat = { id, title, createdAt: now, updatedAt: now, agentId: null, scheduleId: null, securityMode: DEFAULT_SECURITY_MODE };
    this.db
      .prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(chat.id, chat.title, chat.createdAt, chat.updatedAt);
    return chat;
  }

  rename(id: string, title: string): void {
    this.db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), id);
  }

  // Read straight from the row instead of going through get() + list()'s
  // ordering — called from inside the tools node on every turn that has
  // tool calls, so it stays a single indexed lookup.
  getSecurityMode(id: string): SecurityMode {
    const row = this.db.prepare("SELECT security_mode FROM chats WHERE id = ?").get(id) as { security_mode?: string | null } | undefined;
    return (row?.security_mode as SecurityMode | null) ?? DEFAULT_SECURITY_MODE;
  }

  setSecurityMode(id: string, mode: SecurityMode): void {
    this.db.prepare("UPDATE chats SET security_mode = ? WHERE id = ?").run(mode, id);
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
