import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
  TASKS,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";

// A minimal SQLite-backed checkpointer, modeled directly on the shipped
// MemorySaver's own logic (same file, same table shape as the LangGraph.js
// Python/JS convention) but persisted to disk instead of an in-process Map.
// Written by hand instead of pulling in @langchain/langgraph-checkpoint-sqlite:
// that package's available releases target either @langchain/core <0.3
// (0.0.x) or the unrelated LangGraph v1 line (1.x) — neither matches this
// project's @langchain/core ^0.3 / langgraph ^0.2 pin. node:sqlite is a
// built-in as of Node 22+ (this project already requires Node 24+), so this
// adds zero new dependencies and no native build step.
//
// This is what makes the CLI and the web interface share memory: both
// processes point at the same database file and thread id, so a checkpoint
// written by one is immediately visible to the other on its next read —
// no shared server process required.

interface CheckpointRow {
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

interface ListRow extends CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
}

export class SqliteSaver extends BaseCheckpointSaver {
  private db: DatabaseSync;
  private insertCheckpoint: StatementSync;
  private insertWriteIgnore: StatementSync;
  private upsertWrite: StatementSync;

  constructor(dbPath: string, serde?: SerializerProtocol) {
    super(serde);
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint BLOB NOT NULL,
        metadata BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        value BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);

    this.insertCheckpoint = this.db.prepare(`
      INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
      DO UPDATE SET parent_checkpoint_id = excluded.parent_checkpoint_id,
                    checkpoint = excluded.checkpoint,
                    metadata = excluded.metadata
    `);
    // Regular writes are write-once per (task, idx) — matches MemorySaver,
    // which silently drops a repeat write instead of overwriting it.
    this.insertWriteIgnore = this.db.prepare(`
      INSERT OR IGNORE INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // Special writes (negative idx, e.g. errors) do get overwritten.
    this.upsertWrite = this.db.prepare(`
      INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      DO UPDATE SET channel = excluded.channel, value = excluded.value
    `);
  }

  private async pendingSends(threadId: string, checkpointNs: string, parentCheckpointId?: string) {
    if (!parentCheckpointId) return [];
    const rows = this.db
      .prepare(
        "SELECT value FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND channel = ? ORDER BY idx",
      )
      .all(threadId, checkpointNs, parentCheckpointId, TASKS) as { value: Uint8Array }[];
    return Promise.all(rows.map((row) => this.serde.loadsTyped("json", row.value)));
  }

  private async pendingWrites(threadId: string, checkpointNs: string, checkpointId: string) {
    const rows = this.db
      .prepare(
        "SELECT task_id, channel, value FROM writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? ORDER BY idx",
      )
      .all(threadId, checkpointNs, checkpointId) as { task_id: string; channel: string; value: Uint8Array }[];
    return Promise.all(
      rows.map(
        async (row) => [row.task_id, row.channel, await this.serde.loadsTyped("json", row.value)] as [string, string, unknown],
      ),
    );
  }

  private async toTuple(threadId: string, checkpointNs: string, row: CheckpointRow): Promise<CheckpointTuple> {
    const pendingSends = await this.pendingSends(threadId, checkpointNs, row.parent_checkpoint_id ?? undefined);
    const checkpoint = {
      ...(await this.serde.loadsTyped("json", row.checkpoint)),
      pending_sends: pendingSends,
    };
    const metadata = await this.serde.loadsTyped("json", row.metadata);
    const pendingWrites = await this.pendingWrites(threadId, checkpointNs, row.checkpoint_id);

    const tuple: CheckpointTuple = {
      config: {
        configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: row.checkpoint_id },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: row.parent_checkpoint_id },
      };
    }
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const requestedId = getCheckpointId(config);

    const row = requestedId
      ? (this.db
          .prepare(
            "SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?",
          )
          .get(threadId, checkpointNs, requestedId) as CheckpointRow | undefined)
      : (this.db
          .prepare(
            "SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1",
          )
          .get(threadId, checkpointNs) as CheckpointRow | undefined);

    if (!row) return undefined;
    return this.toTuple(threadId, checkpointNs, row);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {};
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;

    let sql =
      "SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints WHERE 1 = 1";
    const params: SQLInputValue[] = [];
    if (threadId) {
      sql += " AND thread_id = ?";
      params.push(threadId);
    }
    if (checkpointNs !== undefined) {
      sql += " AND checkpoint_ns = ?";
      params.push(checkpointNs);
    }
    if (before?.configurable?.checkpoint_id) {
      sql += " AND checkpoint_id < ?";
      params.push(before.configurable.checkpoint_id);
    }
    sql += " ORDER BY checkpoint_id DESC";

    const rows = this.db.prepare(sql).all(...params) as unknown as ListRow[];

    let yielded = 0;
    for (const row of rows) {
      if (limit !== undefined && yielded >= limit) break;

      const metadata = (await this.serde.loadsTyped("json", row.metadata)) as Record<string, unknown>;
      if (filter && !Object.entries(filter).every(([key, value]) => metadata[key] === value)) continue;

      yielded += 1;
      yield this.toTuple(row.thread_id, row.checkpoint_ns, row);
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const prepared = copyCheckpoint(checkpoint);
    delete (prepared as { pending_sends?: unknown }).pending_sends;

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    if (threadId === undefined) {
      throw new Error('Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field.');
    }

    const [, serializedCheckpoint] = this.serde.dumpsTyped(prepared);
    const [, serializedMetadata] = this.serde.dumpsTyped(metadata);

    this.insertCheckpoint.run(
      threadId,
      checkpointNs,
      checkpoint.id,
      config.configurable?.checkpoint_id ?? null,
      serializedCheckpoint,
      serializedMetadata,
    );

    return {
      configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;
    if (threadId === undefined) {
      throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field.');
    }
    if (checkpointId === undefined) {
      throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field.');
    }

    writes.forEach(([channel, value], idx) => {
      const [, serializedValue] = this.serde.dumpsTyped(value);
      const writeIdx = WRITES_IDX_MAP[channel] ?? idx;
      const statement = writeIdx >= 0 ? this.insertWriteIgnore : this.upsertWrite;
      statement.run(threadId, checkpointNs, checkpointId, taskId, writeIdx, channel, serializedValue);
    });
  }

  // Used when a chat is deleted (see src/core/memory/chats.ts) so its
  // checkpoint history doesn't linger in the database as orphaned rows.
  deleteThread(threadId: string): void {
    this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
  }
}

let sharedCheckpointer: SqliteSaver | undefined;

// Lazily created and reused within a process — both entry points (CLI, web
// server) call this once at startup, each getting its own SqliteSaver
// instance pointed at the same file, which is how they end up sharing state.
export function getCheckpointer(dbPath: string): SqliteSaver {
  if (!sharedCheckpointer) sharedCheckpointer = new SqliteSaver(dbPath);
  return sharedCheckpointer;
}
