import { config as appConfig } from "../config.js";
import { createNemotronModel } from "./llm/nemotron.js";
import { getUserModelRegistry, type ObservationCategory } from "./memory/userModel.js";
import { log } from "./logger.js";

// Passive memory extraction — the "continuous learning" counterpart to
// /goal mode's judgeGoal (goalJudge.ts): a separate, short-lived, cheap LLM
// call that looks at ONE exchange (not the whole conversation) and decides
// whether it reveals something durable and generalizable about the user,
// without ULTRON ever being asked to remember it. Same reasoning as
// gatherCodeContext's comment in goalJudge.ts — deliberately narrow context
// so this stays cheap enough to run after every turn.

const MAX_MESSAGE_CHARS = 2000;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated]` : text;
}

const EXTRACTOR_SYSTEM_PROMPT = `You are a quiet observer watching a single exchange between a user and their personal AI agent, ULTRON. Your only job: decide whether this exchange reveals a durable, generalizable fact, preference, or behavioral pattern about the USER — something worth remembering for future conversations, not specific to solving today's task.

Reply with exactly one JSON object on a single line, nothing else:
{"observation": null}
{"observation": "<one short sentence, third person, about the user>", "category": "preference"}

Rules:
- Return null far more often than not. Most exchanges are just task work and reveal nothing durable — a specific bug fix, a one-off question, small talk. Only report something that would still be true and useful weeks from now.
- category "preference": how the user likes things done (terse replies, decide-for-them vs ask-first, a tool or format they favor).
- category "fact": a stable fact about the user, their environment, or their work (their stack, their role, a recurring project).
- category "pattern": a recurring behavior noticed in this exchange (cuts off long explanations, works late, retries the same request differently).
- Never invent anything not actually evidenced by the text you were given. When unsure, return null.
- Keep the observation itself to one plain sentence, no preamble, third person ("the user prefers...", not "I prefer...").`;

export interface ExtractedObservation {
  content: string;
  category: ObservationCategory;
}

function parseObservation(raw: string): ExtractedObservation | undefined {
  const text = raw.trim();
  const match = text.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : text;
  try {
    const data = JSON.parse(jsonText) as { observation?: unknown; category?: unknown };
    if (typeof data.observation !== "string" || !data.observation.trim()) return undefined;
    const category: ObservationCategory =
      data.category === "preference" || data.category === "fact" || data.category === "pattern" ? data.category : "fact";
    return { content: data.observation.trim(), category };
  } catch {
    return undefined;
  }
}

export async function extractUserModelObservation(
  humanMessage: string,
  aiMessage: string,
  signal?: AbortSignal,
): Promise<ExtractedObservation | undefined> {
  if (!humanMessage.trim() || !aiMessage.trim()) return undefined;
  const model = createNemotronModel("low");
  const response = await model.invoke(
    [
      { role: "system" as const, content: EXTRACTOR_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: `User said:\n${truncate(humanMessage.trim(), MAX_MESSAGE_CHARS)}\n\nULTRON replied:\n${truncate(aiMessage.trim(), MAX_MESSAGE_CHARS)}\n\nObservation?`,
      },
    ],
    { signal },
  );
  const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  return parseObservation(raw);
}

// Fire-and-forget from both interfaces after a turn completes successfully
// (see interfaces/cli/index.ts's executeTurn and interfaces/web/server.ts's
// streamGraphTurn) — never awaited on the critical path, and any failure
// (API error, unparsable reply) is swallowed after logging: a missed
// observation is a non-event, not something worth surfacing to the user or
// retrying.
export async function recordUserModelObservation(chatId: string, humanText: string, aiText: string): Promise<void> {
  try {
    const observation = await extractUserModelObservation(humanText, aiText);
    if (!observation) return;
    getUserModelRegistry(appConfig.databasePath).add(observation.content, observation.category, chatId);
  } catch (err) {
    log("usermodel", `extraction failed chat=${chatId} error=${err instanceof Error ? err.message : String(err)}`);
  }
}
