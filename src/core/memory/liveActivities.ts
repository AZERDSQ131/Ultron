import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";
import { DatabaseSync } from "node:sqlite";

export type LiveActivityStatus = "running" | "completed" | "failed" | "waitingForApproval";

export interface LiveActivityAction {
  id: string;
  label: string;
}

interface LiveActivityRow {
  activity_id: string;
  chat_id: string;
  push_token: string;
  status: LiveActivityStatus;
  latest_action: string;
  actions_json: string;
}

interface APNsConfig {
  keyId?: string;
  teamId?: string;
  privateKeyPath?: string;
  privateKey?: string;
  environment: "sandbox" | "production";
  bundleId: string;
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

  async send(
    pushToken: string,
    status: LiveActivityStatus,
    latestAction: string,
    actions: LiveActivityAction[],
    end: boolean,
  ): Promise<number> {
    if (!this.enabled) return 0;
    if (!this.token || Date.now() - this.tokenIssuedAt > 45 * 60 * 1000) {
      this.token = makeProviderToken(this.config);
      this.tokenIssuedAt = Date.now();
    }
    if (!this.token) return 0;

    const payload: Record<string, unknown> = {
      aps: {
        timestamp: Math.floor(Date.now() / 1000),
        event: end ? "end" : "update",
        "content-state": { status, latestAction, actions },
        ...(end ? { "dismissal-date": Math.floor(Date.now() / 1000) + 30 * 60 } : { "stale-date": Math.floor(Date.now() / 1000) + 15 * 60 }),
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
          "apns-priority": end || status === "completed" || status === "failed" ? "10" : "5",
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

export class LiveActivityRegistry {
  private readonly db: DatabaseSync;
  private readonly publisher: APNsPublisher;
  private readonly lastPushAt = new Map<string, number>();

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
         VALUES (?, ?, ?, 'running', 'Traitement en cours', '[]', ?)
         ON CONFLICT(activity_id) DO UPDATE SET chat_id = excluded.chat_id, push_token = excluded.push_token, updated_at = excluded.updated_at`,
      )
      .run(activityId, chatId, pushToken, now);
  }

  async publish(
    chatId: string,
    status: LiveActivityStatus,
    latestAction: string,
    options: { force?: boolean; end?: boolean } = {},
  ): Promise<void> {
    const rows = this.rowsForChat(chatId);
    if (!rows.length) return;

    const currentActions = this.parseActions(rows[0].actions_json);
    const nextActions = latestAction === rows[0].latest_action
      ? currentActions
      : [...currentActions, { id: `${Date.now()}`, label: latestAction }].slice(-5);
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE live_activities SET status = ?, latest_action = ?, actions_json = ?, updated_at = ? WHERE chat_id = ?")
      .run(status, latestAction.slice(0, 160), JSON.stringify(nextActions), now, chatId);

    const lastPush = this.lastPushAt.get(chatId) ?? 0;
    if (!options.force && Date.now() - lastPush < 1000) return;
    this.lastPushAt.set(chatId, Date.now());

    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.publisher.send(row.push_token, status, latestAction.slice(0, 160), nextActions, options.end === true);
        } catch {
          // APNs is an optional transport; local ActivityKit updates and the
          // persisted task state must continue working when it is unavailable.
        }
      }),
    );

    if (options.end) this.db.prepare("DELETE FROM live_activities WHERE chat_id = ?").run(chatId);
  }

  private rowsForChat(chatId: string): LiveActivityRow[] {
    return this.db
      .prepare("SELECT activity_id, chat_id, push_token, status, latest_action, actions_json FROM live_activities WHERE chat_id = ?")
      .all(chatId) as unknown as LiveActivityRow[];
  }

  private parseActions(raw: string): LiveActivityAction[] {
    try {
      const actions = JSON.parse(raw) as LiveActivityAction[];
      return Array.isArray(actions) ? actions : [];
    } catch {
      return [];
    }
  }
}

let sharedRegistry: LiveActivityRegistry | undefined;

export function getLiveActivityRegistry(dbPath: string, apns: APNsConfig): LiveActivityRegistry {
  if (!sharedRegistry) sharedRegistry = new LiveActivityRegistry(dbPath, apns);
  return sharedRegistry;
}
