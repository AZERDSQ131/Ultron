import type { OpenAIAuthRegistry } from "../memory/openaiAuth.js";

// ChatGPT device-code OAuth — the same mechanism OpenAI's own open-source
// `codex` CLI uses to sign in with a ChatGPT Plus/Pro/Team account and use
// its included model quota instead of a metered api.openai.com key.
// Verified directly against openai/codex's Rust source (codex-rs/login/src)
// rather than assumed from docs — every endpoint, param name and client_id
// below matches that implementation exactly.

const AUTH_BASE_URL = "https://auth.openai.com";
const ACCOUNTS_BASE_URL = `${AUTH_BASE_URL}/api/accounts`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REVOKE_URL = `${AUTH_BASE_URL}/oauth/revoke`;
// Device-code exchanges use this fixed non-local redirect_uri (there's no
// local browser callback in this flow, unlike codex's interactive browser
// login) — matches complete_device_code_login in device_code_auth.rs.
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
// Public PKCE client id, safe to hardcode (no client_secret exists for a
// PKCE public client) — from codex-rs/login/src/auth/manager.rs's CLIENT_ID.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface DeviceCodeSession {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export function decodeAccountEmail(idToken: string): string | null {
  const claims = decodeJwtPayload(idToken);
  const email = claims.email ?? (claims["https://api.openai.com/profile"] as Record<string, unknown> | undefined)?.email;
  return typeof email === "string" ? email : null;
}

// The Codex backend rejects requests with no `ChatGPT-Account-ID` header
// (400) — confirmed against openai/codex's model-provider/src/auth.rs,
// where every ChatGPT-auth request adds this header from the account id
// carried in the `https://api.openai.com/auth` id_token claim.
export function decodeAccountId(idToken: string): string | null {
  const claims = decodeJwtPayload(idToken);
  const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" ? accountId : null;
}

// Every authenticated Codex backend request needs both headers below, not
// just the bearer token — see decodeAccountId's comment.
export function codexAuthHeaders(accessToken: string, accountId: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
    "OAI-Product-Sku": "codex",
  };
}

function accessTokenExpirySeconds(accessToken: string): number | undefined {
  const claims = decodeJwtPayload(accessToken);
  return typeof claims.exp === "number" ? claims.exp : undefined;
}

export async function requestDeviceCode(): Promise<DeviceCodeSession> {
  const response = await fetch(`${ACCOUNTS_BASE_URL}/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`device code request failed with status ${response.status}`);
  const data = (await response.json()) as { device_auth_id: string; user_code: string; interval?: number | string };
  const intervalSeconds = typeof data.interval === "string" ? Number(data.interval) : (data.interval ?? 5);
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: `${AUTH_BASE_URL}/codex/device`,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 5,
  };
}

// Polls until the user approves the code in a browser, then exchanges the
// resulting authorization code for real tokens — mirrors
// complete_device_code_login in codex-rs/login/src/device_code_auth.rs.
interface DeviceCodeSuccess {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

async function pollDeviceCode(session: DeviceCodeSession, signal: AbortSignal | undefined, started: number, maxWaitMs: number): Promise<DeviceCodeSuccess> {
  for (;;) {
    if (signal?.aborted) throw new Error("device code login cancelled");
    if (Date.now() - started >= maxWaitMs) throw new Error("device code login timed out after 15 minutes");

    const response = await fetch(`${ACCOUNTS_BASE_URL}/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
    });

    if (response.ok) return (await response.json()) as DeviceCodeSuccess;
    if (response.status === 403 || response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, session.intervalSeconds * 1000));
      continue;
    }
    throw new Error(`device auth failed with status ${response.status}`);
  }
}

export async function pollAndExchange(session: DeviceCodeSession, signal?: AbortSignal): Promise<TokenSet> {
  const maxWaitMs = 15 * 60 * 1000;
  const started = Date.now();
  const codeResp = await pollDeviceCode(session, signal, started, maxWaitMs);

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: codeResp.authorization_code,
      redirect_uri: DEVICE_REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeResp.code_verifier,
    }).toString(),
  });
  if (!tokenResponse.ok) throw new Error(`token exchange failed with status ${tokenResponse.status}`);
  const tokens = (await tokenResponse.json()) as { id_token: string; access_token: string; refresh_token: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token };
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!response.ok) throw new Error(`token refresh failed with status ${response.status}`);
  const tokens = (await response.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
  return {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? refreshToken,
    idToken: tokens.id_token ?? "",
  };
}

export async function revoke(accessToken: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, token: accessToken }),
  }).catch(() => {
    // Best-effort — clearing the local row is what actually matters.
  });
}

const REFRESH_MARGIN_SECONDS = 60;

// The one function everything else calls: returns a bearer token guaranteed
// usable right now, refreshing proactively if the stored one is expired or
// about to be. Throws a clear, actionable error if never logged in.
export async function getValidAccessToken(registry: OpenAIAuthRegistry): Promise<string> {
  const { accessToken } = await getValidAuth(registry);
  return accessToken;
}

// Same as getValidAccessToken, but also returns the account id every Codex
// backend request must send alongside the bearer token (see
// decodeAccountId's comment) — use codexAuthHeaders(accessToken, accountId)
// to build the actual request headers.
export async function getValidAuth(registry: OpenAIAuthRegistry): Promise<{ accessToken: string; accountId: string | null }> {
  const stored = registry.get();
  if (!stored) throw new Error('Not connected to ChatGPT — run "/login openai" first.');

  const expiry = accessTokenExpirySeconds(stored.accessToken);
  const nowSeconds = Date.now() / 1000;
  if (expiry !== undefined && expiry - nowSeconds > REFRESH_MARGIN_SECONDS) {
    return { accessToken: stored.accessToken, accountId: stored.accountId ?? decodeAccountId(stored.idToken) };
  }

  const refreshed = await refreshTokens(stored.refreshToken);
  const idToken = refreshed.idToken || stored.idToken;
  const accountEmail = refreshed.idToken ? decodeAccountEmail(refreshed.idToken) : stored.accountEmail;
  const accountId = decodeAccountId(idToken) ?? stored.accountId;
  registry.save({
    accessToken: refreshed.accessToken || stored.accessToken,
    refreshToken: refreshed.refreshToken || stored.refreshToken,
    idToken,
    accountEmail,
    accountId,
  });
  return { accessToken: refreshed.accessToken || stored.accessToken, accountId };
}
