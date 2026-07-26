import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Chat "projects" — a lightweight grouping folder a user creates (name,
// emoji icon, color) and assigns conversations to, mirroring ChatGPT-style
// projects. Deliberately just a label on a chat row (chats.project_id),
// not a separate conversation container: a chat's LangGraph thread_id and
// history are completely unaffected by which project it belongs to, so
// moving a chat in/out of a project is a single UPDATE, not a data move.

export interface Project {
  id: string;
  name: string;
  icon: string;
  color: string;
  createdAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  icon: string;
  color: string;
  created_at: string;
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, icon: row.icon, color: row.color, createdAt: row.created_at };
}

export class ProjectRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    // Lives on the same connection/file as chats, but declared here (not in
    // chats.ts) since it's this table's foreign concept — a chat doesn't
    // need to know projects exist beyond carrying this one nullable column.
    try { this.db.exec("ALTER TABLE chats ADD COLUMN project_id TEXT"); } catch { /* already migrated */ }
  }

  list(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  create(name: string, icon: string, color: string): Project {
    const project: Project = { id: randomUUID(), name, icon, color, createdAt: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO projects (id, name, icon, color, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.icon, project.color, project.createdAt);
    return project;
  }

  update(id: string, fields: { name?: string; icon?: string; color?: string }): Project | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const name = fields.name?.trim() || existing.name;
    const icon = fields.icon ?? existing.icon;
    const color = fields.color ?? existing.color;
    this.db.prepare("UPDATE projects SET name = ?, icon = ?, color = ? WHERE id = ?").run(name, icon, color, id);
    return this.get(id);
  }

  // Deleting a project only removes the folder — member chats are
  // unassigned (project_id cleared), not deleted, same "metadata flag, not
  // a data operation" spirit as ChatRegistry.archive.
  delete(id: string): boolean {
    this.db.prepare("UPDATE chats SET project_id = NULL WHERE project_id = ?").run(id);
    const deleted = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return Number(deleted.changes ?? 0) > 0;
  }

  getChatProject(chatId: string): string | null {
    const row = this.db.prepare("SELECT project_id FROM chats WHERE id = ?").get(chatId) as { project_id?: string | null } | undefined;
    return row?.project_id ?? null;
  }

  setChatProject(chatId: string, projectId: string | null): void {
    this.db.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(projectId, chatId);
  }

  // Bulk lookup for GET /api/chats so the response can attach each chat's
  // projectId without one query per row.
  allChatProjects(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, project_id FROM chats WHERE project_id IS NOT NULL").all() as unknown as { id: string; project_id: string }[];
    return new Map(rows.map((row) => [row.id, row.project_id]));
  }
}

let sharedRegistry: ProjectRegistry | undefined;

export function getProjectRegistry(dbPath: string): ProjectRegistry {
  if (!sharedRegistry) sharedRegistry = new ProjectRegistry(dbPath);
  return sharedRegistry;
}
