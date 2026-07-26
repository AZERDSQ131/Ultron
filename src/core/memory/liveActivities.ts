import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";
import { DatabaseSync } from "node:sqlite";

export type LiveActivityStatus = "running" | "completed" | "failed" | "waitingForApproval";

export type LiveActivityEntryKind = "message" | "tool" | "status";

export interface LiveActivityEntry {
  id: string;
  kind: LiveActivityEntryKind;
  text: string;
}

/// Mirrors `ULTRONTaskActivityAttributes.ContentState` on the iOS side
/// (`ios/Shared/ULTRONTaskActivityAttributes.swift`). Field names and types have
/// to stay in lockstep: a pushed update that fails to decode is dropped
/// silently by ActivityKit.
interface LiveActivityContentState {
  status: LiveActivityStatus;
  entries: LiveActivityEntry[];
  startedAt: number;
}

export interface LiveActivityTurnState {
  status: LiveActivityStatus;
  entries: LiveActivityEntry[];
  startedAt: number;
  running: boolean;
  updatedAt: number;
}

interface PushTokenRow {
  activity_id: string;
  push_token: string;
}

interface APNsConfig {
  keyId?: string;
  teamId?: string;
  privateKeyPath?: string;
  privateKey?: string;
  environment: "sandbox" | "production";
  bundleId: string;
}

const MAX_ENTRIES = 6;
const MESSAGE_TAIL = 140;
const ENTRY_MAX = 160;
const PUSH_THROTTLE_MS = 1000;
/// How long a finished turn's state stays queryable, so the app can reconcile
/// after being suspended through the end of a turn.
const TERMINAL_RETENTION_MS = 30 * 60 * 1000;

function nowSeconds(): number {
  return Date.now() / 1000;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function makeProviderToken(config: APNsConfig): string | undefined {
  if (!config.keyId || !config.teamId || (!config.privateKeyPath && !config.privateKey)) return undefined;
  const privateKey = (config.privateKeyPath ? readFileSync(config.privateKeyPath, "utf8") : config.privateKey!).replace(/\\n/g, "\n");
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }));
  const signer = createSign("sha256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(createPrivateKey(privateKey)))}`;
}

class APNsPublisher {
  private token?: string;
  private tokenIssuedAt = 0;

  constructor(private readonly config: APNsConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.keyId && this.config.teamId && (this.config.privateKeyPath || this.config.privateKey));
  }

  async send(pushToken: string, state: LiveActivityContentState, end: boolean): Promise<number> {
    if (!this.enabled) return 0;
    if (!this.token || Date.now() - this.tokenIssuedAt > 45 * 60 * 1000) {
      this.token = makeProviderToken(this.config);
      this.tokenIssuedAt = Date.now();
    }
    if (!this.token) return 0;

    const seconds = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      aps: {
        timestamp: seconds,
        event: end ? "end" : "update",
        "content-state": state,
        ...(end ? { "dismissal-date": seconds + 8 } : { "stale-date": seconds + 5 * 60 }),
      },
    };
    const host = this.config.environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
    const session = connect(`https://${host}`);
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = session.request({
          ":method": "POST",
          ":path": `/3/device/${pushToken}`,
          authorization: `bearer ${this.token}`,
          "apns-topic": `${this.config.bundleId}.push-type.liveactivity`,
          "apns-push-type": "liveactivity",
          "apns-priority": end || state.status !== "running" ? "10" : "5",
          "content-type": "application/json",
        });
        let responseBody = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => (responseBody += chunk));
        request.on("error", reject);
        request.on("response", (headers) => {
          request.on("end", () => {
            const statusCode = Number(headers[":status"] ?? 0);
            if (statusCode >= 200 && statusCode < 300) resolve(statusCode);
            else reject(new Error(`APNs returned HTTP ${statusCode}: ${responseBody}`));
          });
        });
        request.end(JSON.stringify(payload));
      });
    } finally {
      session.close();
    }
  }
}

/// Tracks the turn currently running for each chat and, when APNs credentials
/// exist, mirrors it onto the device's Live Activity.
///
/// The turn state is held in memory, not in SQLite, and deliberately so: it only
/// describes work this very process is running, so it is worthless after a
/// restart. It is also kept independently of any registered push token, because
/// a build signed with a free Apple Developer account never gets one — the app
/// polls `getState` on foreground instead (`LiveActivityManager.reconcile`), and
/// that path has to work with the APNs transport completely dark.
export class LiveActivityRegistry {
  private readonly db: DatabaseSync;
  private readonly publisher: APNsPublisher;
  private readonly turns = new Map<string, LiveActivityTurnState>();
  private readonly streamingEntryId = new Map<string, string>();
  private readonly lastPushAt = new Map<string, number>();
  private counter = 0;

  constructor(dbPath: string, apns: APNsConfig) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_activities (
        activity_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        push_token TEXT NOT NULL,
        status TEXT NOT NULL,
        latest_action TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_live_activities_chat ON live_activities (chat_id)");
    this.publisher = new APNsPublisher(apns);
  }

  register(chatId: string, activityId: string, pushToken: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO live_activities (activity_id, chat_id, push_token, status, latest_action, actions_json, updated_at)
         VALUES (?, ?, ?, 'running', '', '[]', ?)
         ON CONFLICT(activity_id) DO UPDATE SET chat_id = excluded.chat_id, push_token = excluded.push_token, updated_at = excluded.updated_at`,
      )
      .run(activityId, chatId, pushToken, now);
  }

  getState(chatId: string): LiveActivityTurnState | undefined {
    return this.turns.get(chatId);
  }

  /// Starts a fresh turn. Resets the transcript so a new turn never inherits the
  /// previous one's lines.
  begin(chatId: string): void {
    this.prune();
    this.turns.set(chatId, {
      status: "running",
      entries: [],
      startedAt: nowSeconds(),
      running: true,
      updatedAt: Date.now(),
    });
    this.streamingEntryId.delete(chatId);
    this.lastPushAt.delete(chatId);
  }

  /// `fullText` is the reply accumulated so far. Rewrites the streaming line in
  /// place instead of appending one entry per token.
  noteMessage(chatId: string, fullText: string): void {
    const turn = this.turns.get(chatId);
    if (!turn) return;
    const text = fullText.trim().slice(-MESSAGE_TAIL);
    if (!text) return;

    const streamingId = this.streamingEntryId.get(chatId);
    const existing = streamingId ? turn.entries.find((entry) => entry.id === streamingId) : undefined;
    if (existing) {
      existing.text = text;
    } else {
      const entry = this.appendEntry(turn, "message", text);
      this.streamingEntryId.set(chatId, entry.id);
    }
    turn.updatedAt = Date.now();
    void this.push(chatId, { throttled: true });
  }

  /// A tool call or its result. Closes the streaming line: text arriving after a
  /// tool call is a new paragraph, not a continuation.
  noteTool(chatId: string, text: string): void {
    const turn = this.turns.get(chatId);
    if (!turn) return;
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.streamingEntryId.delete(chatId);
    this.appendEntry(turn, "tool", clean);
    turn.updatedAt = Date.now();
    void this.push(chatId, { throttled: false });
  }

  awaitApproval(chatId: string): void {
    const turn = this.turns.get(chatId);
    if (!turn) return;
    this.streamingEntryId.delete(chatId);
    this.appendEntry(turn, "status", "Approbation requise");
    turn.status = "waitingForApproval";
    turn.running = false;
    turn.updatedAt = Date.now();
    void this.push(chatId, { throttled: false });
  }

  /// `reason` is only worth a transcript line when something went wrong — on
  /// success the green check already says it, and spending one of the few
  /// visible slots on a "Terminé" line just pushes real content out of view.
  finish(chatId: string, status: "completed" | "failed", reason?: string): void {
    const turn = this.turns.get(chatId);
    if (!turn) return;
    this.streamingEntryId.delete(chatId);
    if (status === "failed" && reason) this.appendEntry(turn, "status", reason);
    turn.status = status;
    turn.running = false;
    turn.updatedAt = Date.now();
    void this.push(chatId, { throttled: false, end: true });
  }

  private appendEntry(turn: LiveActivityTurnState, kind: LiveActivityEntryKind, text: string): LiveActivityEntry {
    this.counter += 1;
    const entry: LiveActivityEntry = { id: `${this.counter}`, kind, text: text.slice(0, ENTRY_MAX) };
    turn.entries.push(entry);
    if (turn.entries.length > MAX_ENTRIES) turn.entries.splice(0, turn.entries.length - MAX_ENTRIES);
    return entry;
  }

  /// Never rejects: callers fire this without awaiting, and a broken push must
  /// not take down the turn that triggered it.
  private async push(chatId: string, options: { throttled: boolean; end?: boolean }): Promise<void> {
    try {
      if (!this.publisher.enabled) return;
      const turn = this.turns.get(chatId);
      if (!turn) return;

      if (options.throttled && Date.now() - (this.lastPushAt.get(chatId) ?? 0) < PUSH_THROTTLE_MS) return;
      this.lastPushAt.set(chatId, Date.now());

      const rows = this.db
        .prepare("SELECT activity_id, push_token FROM live_activities WHERE chat_id = ?")
        .all(chatId) as unknown as PushTokenRow[];
      if (!rows.length) return;

      const state: LiveActivityContentState = {
        status: turn.status,
        entries: turn.entries,
        startedAt: turn.startedAt,
      };

      await Promise.all(
        rows.map(async (row) => {
          try {
            await this.publisher.send(row.push_token, state, options.end === true);
          } catch {
            // APNs is an optional transport: the in-memory turn state and the
            // app's own foreground reconcile must keep working without it.
          }
        }),
      );

      if (options.end) this.db.prepare("DELETE FROM live_activities WHERE chat_id = ?").run(chatId);
    } catch {
      // Same reasoning as above, for the SQLite lookup and payload build.
    }
  }

  private prune(): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (const [chatId, turn] of this.turns) {
      if (!turn.running && turn.updatedAt < cutoff) {
        this.turns.delete(chatId);
        this.streamingEntryId.delete(chatId);
        this.lastPushAt.delete(chatId);
      }
    }
  }
}

let sharedRegistry: LiveActivityRegistry | undefined;

export function getLiveActivityRegistry(dbPath: string, apns: APNsConfig): LiveActivityRegistry {
  if (!sharedRegistry) sharedRegistry = new LiveActivityRegistry(dbPath, apns);
  return sharedRegistry;
}
