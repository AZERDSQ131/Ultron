import "dotenv/config";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export const config = {
  nvidiaApiKey: required("NVIDIA_API_KEY"),
  nemotronModel: process.env.NEMOTRON_MODEL ?? "nvidia/nemotron-3-super-120b-a12b",
  nemotronBaseUrl: process.env.NEMOTRON_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  webSearchProvider: process.env.WEB_SEARCH_PROVIDER ?? "auto",
  tavilyApiKey: process.env.TAVILY_API_KEY,
  // Reference point for the context gauge in the CLI: 262,144 tokens
  // (~262k), per the user directly — the "up to 1M" figure surfaced by web
  // search was wrong for this served model, trust the correction over that.
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS ?? 262_144),
  webPort: Number(process.env.WEB_PORT ?? 4173),
  // Shared checkpoint database: the CLI and the web interface each open
  // their own connection to this same file, which is how they end up
  // seeing the same thread and memory instead of two disconnected sessions.
  databasePath: (() => {
    const raw = process.env.DATABASE_PATH ?? "ultron-state.sqlite3";
    return isAbsolute(raw) ? raw : join(projectRoot, raw);
  })(),
};
