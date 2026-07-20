import { execSync } from "node:child_process";
import { createNemotronModel } from "./llm/nemotron.js";
import { recordUsage } from "./llm/usage.js";
import { config as appConfig } from "../config.js";
import { getHealthRegistry } from "./memory/health.js";

// The verification half of /goal mode (CLI-only — see interfaces/cli/index.ts's
// driveGoalLoop). This is a SEPARATE, short-lived LLM call, not another turn
// of the main agent's own conversation: it reads the worker's final reply
// and the actual state of the code on disk, and decides whether the goal is
// really done — on evidence, not on the worker's own say-so. Deliberately
// narrow context (final reply + git diff, not the full tool-call history)
// so this check has its own small, cheap context instead of re-consuming
// everything the main turn just spent — see gatherCodeContext below.

const MAX_CODE_CONTEXT_CHARS = 6000;
const MAX_FINAL_MESSAGE_CHARS = 4000;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
}

// Best-effort snapshot of what actually changed on disk. Not a git repo, no
// git installed, or the command fails for any other reason: return "" and
// let the judge work from the final reply alone rather than throwing —
// /goal mode isn't exclusively for coding tasks.
export function gatherCodeContext(cwd: string = process.cwd()): string {
  try {
    const status = execSync("git status --short", { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const diff = execSync("git diff HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    if (!status && !diff) return "";
    return truncate(`git status:\n${status || "(clean)"}\n\ngit diff:\n${diff || "(no tracked changes against HEAD)"}`, MAX_CODE_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

// Sibling to gatherCodeContext — a snapshot of recent health data (see
// HealthRegistry.renderForPrompt) for goals about health/fitness rather
// than code, e.g. "/task goal lower my resting HR". Same fail-open shape:
// never throws, returns "" if there's nothing recorded yet.
export function gatherHealthContext(): string {
  try {
    return getHealthRegistry(appConfig.databasePath).renderForPrompt() ?? "";
  } catch {
    return "";
  }
}

export type GoalVerdict = "done" | "continue" | "blocked";

export interface GoalJudgeResult {
  verdict: GoalVerdict;
  reason: string;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict, independent reviewer for an autonomous agent called ULTRON.

Another instance of ULTRON (the "worker") was given a goal and worked on it autonomously — running shell commands, editing files, searching the web, calling tools — until it stopped and produced a final reply. You did not see any of that work directly. You only see: the goal, the worker's final reply, and (when available) the actual state of the code on disk via git status/diff. Judge from that evidence, not from the worker's claims alone — if it says "done" but the diff shows nothing relevant changed, that is NOT done.

Reply with exactly one JSON object on a single line, nothing else:
{"verdict": "done", "reason": "<one sentence>"}
{"verdict": "continue", "reason": "<one sentence, concrete — tell the worker exactly what's missing or wrong>"}
{"verdict": "blocked", "reason": "<one sentence — why this needs the user, not another retry>"}

Rules:
- "done": the goal is genuinely achieved. Require evidence in the diff/status when the goal implies a code or file change; a reply that only claims success with no matching diff is NOT done. For goals with no code surface (e.g. answering a question, researching something), the reply itself can be the evidence.
- "continue": not yet achieved, but the worker can keep going on its own. Be specific about the gap — the worker only sees your "reason" text, not this conversation, so vague reasons like "not complete" are useless to it.
- "blocked": the worker itself reports being stuck, needs a decision/credential/input only the user can provide, or the same problem is clearly recurring across turns — pushing "continue" again would just waste turns. Prefer "continue" when in doubt; reserve "blocked" for genuine dead ends.`;

function parseVerdict(raw: string): GoalJudgeResult {
  const text = raw.trim();
  const match = text.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : text;
  try {
    const data = JSON.parse(jsonText) as { verdict?: unknown; reason?: unknown };
    const verdict = typeof data.verdict === "string" ? data.verdict.trim().toLowerCase() : "";
    const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "no reason given";
    if (verdict === "done" || verdict === "continue" || verdict === "blocked") return { verdict, reason };
  } catch {
    // fall through to the fail-open default below
  }
  // Fail-open toward "continue", never toward "done" — an unreadable
  // verdict must not be mistaken for silent success. The turn budget
  // (GoalRegistry.maxTurns) is the backstop against this looping forever.
  return {
    verdict: "continue",
    reason: `goal check returned an unreadable verdict — continuing rather than guessing done (raw: ${truncate(text, 200)})`,
  };
}

export interface GoalJudgeInput {
  objective: string;
  finalMessage: string;
  codeContext: string;
  // Optional recent-health snapshot (see gatherHealthContext) — only
  // relevant for health-related goals; omitted entirely from the prompt
  // when empty, same as codeContext.
  healthContext?: string;
}

export async function judgeGoal(input: GoalJudgeInput, signal?: AbortSignal): Promise<GoalJudgeResult> {
  const model = createNemotronModel("low");
  const userPrompt = [
    `Goal:\n${input.objective.trim()}`,
    `Worker's final reply:\n${truncate(input.finalMessage.trim() || "(empty reply)", MAX_FINAL_MESSAGE_CHARS)}`,
    input.codeContext
      ? `Actual state of the code on disk:\n${input.codeContext}`
      : "No code context available (not a git repo, or nothing tracked changed).",
    input.healthContext ? `Recent health data (last 7 days):\n${input.healthContext}` : undefined,
    "Verdict — done, continue, or blocked?",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  const started = Date.now();
  const response = await model.invoke(
    [
      { role: "system" as const, content: JUDGE_SYSTEM_PROMPT },
      { role: "user" as const, content: userPrompt },
    ],
    { signal },
  );
  recordUsage("goal_judge", null, appConfig.nemotronModel, response.usage_metadata?.input_tokens ?? 0, response.usage_metadata?.output_tokens ?? 0, Date.now() - started);
  const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  return parseVerdict(raw);
}

// The next turn's human-role message when the judge says "continue" — a
// normal user-role message appended to the same thread, same as every other
// turn (no system-prompt mutation, no hidden state), so the worker sees
// exactly what a human reviewer would have told it.
export function buildContinuationPrompt(objective: string, reason: string): string {
  return `[Goal check] Not complete yet — ${reason}

Goal: ${objective}

Address the gap above and continue the work. If you believe it's actually done despite this note, explain why concretely in your reply instead of redoing finished work. If you're stuck and need input only the user can give, say so plainly and stop.`;
}
