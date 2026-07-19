import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
  archivedAt: string | null;
  exportPath: string | null;
}

interface ChatRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent_id?: string | null;
  schedule_id?: string | null;
  security_mode?: string | null;
  archived_at?: string | null;
  export_path?: string | null;
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
    archivedAt: row.archived_at ?? null,
    exportPath: row.export_path ?? null,
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
    try { this.db.exec("ALTER TABLE chats ADD COLUMN archived_at TEXT"); } catch { /* already migrated */ }
    try { this.db.exec("ALTER TABLE chats ADD COLUMN export_path TEXT"); } catch { /* already migrated */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_focus (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chat_id TEXT NOT NULL,
        main_chat_id TEXT
      )
    `);
    try { this.db.exec("ALTER TABLE chat_focus ADD COLUMN main_chat_id TEXT"); } catch { /* already migrated */ }
  }

  // Every registered conversation. The archived_at column is retained only
  // as a migration detail for older databases; conversations are no longer
  // archived by the user-facing interfaces.
  list(): Chat[] {
    const rows = this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all() as unknown as ChatRow[];
    return rows.map(toChat);
  }

  // Compatibility name for older callers. /resume now browses every
  // non-main conversation, regardless of the legacy archived_at flag.
  listArchived(): Chat[] {
    const mainId = this.getMain().id;
    return this.list().filter((chat) => chat.id !== mainId);
  }

  // Every chat regardless of archived state — for bulk cleanup (e.g. an
  // Agent's chats must all be purged when the Agent is deleted, archived or
  // not).
  listAll(): Chat[] {
    const rows = this.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all() as unknown as ChatRow[];
    return rows.map(toChat);
  }

  get(id: string): Chat | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
    return row ? toChat(row) : undefined;
  }

  create(title: string = DEFAULT_CHAT_TITLE, agentId: string | null = null, scheduleId: string | null = null): Chat {
    const now = new Date().toISOString();
    const chat: Chat = { id: randomUUID(), title, createdAt: now, updatedAt: now, agentId, scheduleId, securityMode: DEFAULT_SECURITY_MODE, archivedAt: null, exportPath: null };
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
    const chat: Chat = { id, title, createdAt: now, updatedAt: now, agentId: null, scheduleId: null, securityMode: DEFAULT_SECURITY_MODE, archivedAt: null, exportPath: null };
    this.db
      .prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(chat.id, chat.title, chat.createdAt, chat.updatedAt);
    return chat;
  }

  // The main conversation is a shared return point for the CLI and Telegram.
  // Its chat id may rotate when the main conversation is archived; the
  // main_chat_id pointer keeps /main separate from archived history.
  activateMain(): Chat {
    const main = this.getMain();
    if (main.title === DEFAULT_CHAT_TITLE) this.rename(main.id, "Main");
    const activeMain = this.get(main.id)!;
    this.setFocus(activeMain.id);
    return activeMain;
  }

  getMain(): Chat {
    const row = this.db.prepare("SELECT main_chat_id FROM chat_focus WHERE id = 1").get() as { main_chat_id?: string | null } | undefined;
    const configured = row?.main_chat_id ? this.get(row.main_chat_id) : undefined;
    if (configured) return configured;
    const legacy = this.ensure(LEGACY_CHAT_ID, "Main");
    this.setMain(legacy.id);
    return legacy;
  }

  setMain(id: string): Chat | undefined {
    const chat = this.get(id);
    if (!chat) return undefined;
    this.db
      .prepare("INSERT INTO chat_focus (id, chat_id, main_chat_id) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET main_chat_id = excluded.main_chat_id")
      .run(this.getFocus()?.id ?? id, id);
    return chat;
  }

  getFocus(): Chat | undefined {
    const row = this.db.prepare("SELECT chat_id FROM chat_focus WHERE id = 1").get() as { chat_id: string } | undefined;
    return row ? this.get(row.chat_id) : undefined;
  }

  setFocus(id: string): Chat | undefined {
    const chat = this.get(id);
    if (!chat) return undefined;
    this.db
      .prepare("INSERT INTO chat_focus (id, chat_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id")
      .run(id);
    return chat;
  }

  // Archiving is purely a metadata flag, not a data export: the chat's full
  // LangGraph checkpoint state (messages, tool calls, everything) is left
  // untouched under the same thread_id, so unarchive() below gets it back
  // exactly as it was — unlike the old txt-file export/import, which only
  // round-tripped human/ai text and lost tool-call context.
  archive(id: string, title?: string): Chat | undefined {
    if (title?.trim()) this.rename(id, title.trim());
    this.db.prepare("UPDATE chats SET archived_at = ?, updated_at = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), id);
    return this.get(id);
  }

  archiveAndCreate(id: string, title?: string): { archived: Chat | undefined; fresh: Chat } {
    const wasMain = this.getMain().id === id;
    const archived = this.archive(id, title);
    const fresh = this.create(wasMain ? "Main" : DEFAULT_CHAT_TITLE);
    if (wasMain) this.setMain(fresh.id);
    this.setFocus(fresh.id);
    return { archived, fresh };
  }

  // Reopens an archived chat as active again — used by /resume's "invoke"
  // action. The caller is still responsible for switching its own "current
  // chat" pointer to this id.
  unarchive(id: string): Chat | undefined {
    this.db.prepare("UPDATE chats SET archived_at = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.get(id);
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

  // Live export target (see src/core/memory/exporter.ts) — writing this
  // is what turns on the per-turn auto-rewrite hook; clearing it turns
  // the export off without deleting the file already on disk.
  setExportPath(id: string, path: string | null): void {
    this.db.prepare("UPDATE chats SET export_path = ? WHERE id = ?").run(path, id);
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

  // Delete the conversation from the registry only. Its LangGraph checkpoint
  // is intentionally preserved, so this command removes it from /resume and
  // the sidebars without destroying the underlying memory.
  delete(id: string): boolean {
    if (this.getMain().id === id) return false;
    const deleted = this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    if (this.getFocus()?.id === id) this.activateMain();
    return Number(deleted.changes ?? 0) > 0;
  }
}

let sharedRegistry: ChatRegistry | undefined;

export function getChatRegistry(dbPath: string): ChatRegistry {
  if (!sharedRegistry) sharedRegistry = new ChatRegistry(dbPath);
  return sharedRegistry;
}
