import { DatabaseSync } from "node:sqlite";

// Per-chat research notes, backing the "Deep Research" task mode (see
// taskModeDirective in graph.ts).
//
// Why these are persisted rather than just left in the transcript: a deep
// research run is long — dozens of searches and page fetches — and the raw
// pages it read are exactly the kind of bulk content that gets truncated for
// display and pushed out of the context window as the turn grows. If synthesis
// depended on scrolling back through tool results, the report would silently
// get worse the more research was done, which is backwards. Every substantive
// finding is instead written down as it's discovered, with its source, and read
// back in one shot (research_review) at synthesis time.
//
// One row per note, unlike TodoRegistry's single JSON blob per chat: notes are
// appended one at a time throughout a run and queried in aggregate, never
// rewritten as a whole.

export interface ResearchNote {
  id: number;
  aspect: string;
  finding: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  /// What this finding did NOT settle. The canonical deep-research loop feeds
  /// these back into the next round of queries instead of stopping at the first
  /// plausible answer.
  gap: string | null;
  createdAt: string;
}

interface ResearchNoteRow {
  id: number;
  chat_id: string;
  aspect: string;
  finding: string;
  source_url: string | null;
  source_title: string | null;
  gap: string | null;
  created_at: string;
}

function toNote(row: ResearchNoteRow): ResearchNote {
  return {
    id: row.id,
    aspect: row.aspect,
    finding: row.finding,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    gap: row.gap,
    createdAt: row.created_at,
  };
}

export interface ResearchNoteInput {
  aspect: string;
  finding: string;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  gap?: string | null;
}

export class ResearchRegistry {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        aspect TEXT NOT NULL,
        finding TEXT NOT NULL,
        source_url TEXT,
        source_title TEXT,
        gap TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_research_notes_chat ON research_notes (chat_id, id)");
  }

  add(chatId: string, input: ResearchNoteInput): ResearchNote {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO research_notes (chat_id, aspect, finding, source_url, source_title, gap, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chatId,
        input.aspect.trim(),
        input.finding.trim(),
        input.sourceUrl?.trim() || null,
        input.sourceTitle?.trim() || null,
        input.gap?.trim() || null,
        now,
      );
    const row = this.db
      .prepare("SELECT * FROM research_notes WHERE id = last_insert_rowid()")
      .get() as unknown as ResearchNoteRow;
    return toNote(row);
  }

  list(chatId: string): ResearchNote[] {
    return (
      this.db.prepare("SELECT * FROM research_notes WHERE chat_id = ? ORDER BY id ASC").all(chatId) as unknown as ResearchNoteRow[]
    ).map(toNote);
  }

  count(chatId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM research_notes WHERE chat_id = ?")
      .get(chatId) as unknown as { n: number };
    return row.n;
  }

  /// Distinct sources cited so far, in first-seen order — the basis of the
  /// report's bibliography.
  sources(chatId: string): { url: string; title: string | null }[] {
    const seen = new Map<string, string | null>();
    for (const note of this.list(chatId)) {
      if (!note.sourceUrl) continue;
      if (!seen.has(note.sourceUrl)) seen.set(note.sourceUrl, note.sourceTitle);
    }
    return [...seen].map(([url, title]) => ({ url, title }));
  }

  openGaps(chatId: string): { aspect: string; gap: string }[] {
    return this.list(chatId)
      .filter((note): note is ResearchNote & { gap: string } => note.gap !== null)
      .map((note) => ({ aspect: note.aspect, gap: note.gap }));
  }

  /// Cleared at a turn boundary when Deep Research mode is (re)selected, the
  /// same way the to-do list is — otherwise a new, unrelated research question
  /// would synthesise over the previous one's findings.
  clear(chatId: string): void {
    this.db.prepare("DELETE FROM research_notes WHERE chat_id = ?").run(chatId);
  }
}

let sharedRegistry: ResearchRegistry | undefined;

export function getResearchRegistry(dbPath: string): ResearchRegistry {
  if (!sharedRegistry) sharedRegistry = new ResearchRegistry(dbPath);
  return sharedRegistry;
}
