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
  nemotronModel: process.env.NEMOTRON_MODEL ?? "z-ai/glm-5.2",
  nemotronBaseUrl: process.env.NEMOTRON_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  webSearchProvider: process.env.WEB_SEARCH_PROVIDER ?? "auto",
  tavilyApiKey: process.env.TAVILY_API_KEY,
  // Reference point for the context gauge in the CLI: 262,144 tokens
  // (~262k), per the user directly — the "up to 1M" figure surfaced by web
  // search was wrong for this served model, trust the correction over that.
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS ?? 262_144),
  // LangGraph's default (25) counts every node visit, not tool calls — a
  // todo-mode turn with N sub-tasks each needing its own search + a
  // separate todo_update round trip can blow past 25 well before the
  // model is actually stuck looping, killing an otherwise-healthy long
  // turn with GRAPH_RECURSION_LIMIT. Raised well above what a real
  // multi-step research turn needs; still bounded so a truly runaway loop
  // (e.g. the model retrying a failing tool forever) terminates eventually.
  graphRecursionLimit: Number(process.env.GRAPH_RECURSION_LIMIT ?? 150),
  // /goal mode (CLI-only, see src/core/goalJudge.ts): how many worker turns
  // the auto-continuation loop gets before pausing itself rather than
  // burning tokens forever on a goal that never resolves.
  goalMaxTurns: Number(process.env.GOAL_MAX_TURNS ?? 20),
  webPort: Number(process.env.WEB_PORT ?? 4173),
  // Shared checkpoint database: the CLI and the web interface each open
  // their own connection to this same file, which is how they end up
  // seeing the same thread and memory instead of two disconnected sessions.
  databasePath: (() => {
    const raw = process.env.DATABASE_PATH ?? "ultron-state.sqlite3";
    return isAbsolute(raw) ? raw : join(projectRoot, raw);
  })(),
};
