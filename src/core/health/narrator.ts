import { createNemotronModel } from "../llm/nemotron.js";
import type { HealthAnomaly } from "./trends.js";
import type { HealthRecords, HealthSleepDebt } from "../memory/health.js";
import type { BioAgeResult } from "./bioAge.js";
import type { PhotoAnalysis } from "./visionAnalyzer.js";

// Turns already-computed numbers into 2-4 sentences of coach-style prose —
// same pattern as userModelExtractor.ts/goalJudge.ts: a separate, cheap,
// short-lived LLM call (createNemotronModel("low")). Deliberately never
// given the raw daily JSON or even the per-day metric list: only the
// aggregates/anomalies/records already computed deterministically
// elsewhere in this module, so there is nothing for the model to get wrong
// about the underlying numbers — it can only phrase them.

export interface HealthNarrationInput {
  from: string;
  to: string;
  recovery?: number;
  activity?: number;
  anomalies: HealthAnomaly[];
  records: HealthRecords;
  sleepDebt: HealthSleepDebt;
  bioAge?: BioAgeResult;
  // A few date-proximate <user_model> observations (mood/fatigue mentions,
  // etc.) — the one deliberate cross-reference between this module and
  // UserModelRegistry, letting the narration note a correlation neither
  // data source could surface alone.
  relevantObservations?: string[];
}

const NARRATOR_SYSTEM_PROMPT = `You are writing a short, warm, coach-style summary of someone's health data for THEM to read directly. You are given only already-computed numbers (scores, anomalies, records) — never raw sensor data — so treat every number as ground truth, don't second-guess it.

Rules:
- 2-4 sentences, plain prose, no bullet points, no headers.
- Never use clinical or diagnostic language ("you may have X condition") — frame everything as wellness/lifestyle observations.
- If anomalies are present, mention the most significant one plainly but calmly.
- If observations about the person's mood/fatigue are given, you may note a plausible connection to the health data, phrased as an observation, not a claim of causation.
- Do not restate every number given to you — pick what's most worth saying.`;

function buildUserPrompt(input: HealthNarrationInput): string {
  const lines: string[] = [`Period: ${input.from} to ${input.to}.`];
  if (input.recovery !== undefined) lines.push(`Recovery score: ${input.recovery}/100.`);
  if (input.activity !== undefined) lines.push(`Activity score: ${input.activity}/100.`);
  lines.push(`Current activity streak: ${input.records.currentActivityStreakDays} day(s).`);
  lines.push(`Sleep debt over the last 7 days: ${input.sleepDebt.deficitHours.toFixed(1)}h across ${input.sleepDebt.daysCounted} recorded night(s).`);
  if (input.records.bestSleepNight) lines.push(`Best sleep on record: ${(input.records.bestSleepNight.durationSec / 3600).toFixed(1)}h on ${input.records.bestSleepNight.date}.`);
  if (input.records.lowestRestingHR) lines.push(`Lowest resting HR on record: ${input.records.lowestRestingHR.value} on ${input.records.lowestRestingHR.date}.`);
  if (input.bioAge) lines.push(`Estimated biological age: ${input.bioAge.age} (wellness estimate). Factors: ${input.bioAge.explanation.join(" ")}`);
  if (input.anomalies.length) lines.push(`Anomalies: ${input.anomalies.map((a) => a.message).join(" ")}`);
  if (input.relevantObservations?.length) lines.push(`Relevant notes about the person from other conversations: ${input.relevantObservations.join(" ")}`);
  return lines.join("\n");
}

export async function narrateHealth(input: HealthNarrationInput, signal?: AbortSignal): Promise<string> {
  const model = createNemotronModel("low");
  const response = await model.invoke(
    [
      { role: "system" as const, content: NARRATOR_SYSTEM_PROMPT },
      { role: "user" as const, content: buildUserPrompt(input) },
    ],
    { signal },
  );
  const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  return raw.trim();
}

// Same cheap-separate-LLM-call pattern, for Telegram's meal/exercise photo
// side channel (bot.on("message:photo", ...)) — that flow computed macros
// deterministically via the vision model already, but was replying with a
// fixed "Meal logged: X (Ykcal, ...)" template, which read like raw tool
// output instead of a normal conversational confirmation. This phrases the
// same already-computed numbers naturally instead.
const LOG_NARRATOR_SYSTEM_PROMPT = `You just logged a meal or exercise entry from a photo the user sent to their personal health tracker. All the numbers are already computed — never recompute, contradict, or add numbers not given to you. Write ONE short, natural confirmation reply for the user to read directly: 1-2 sentences, conversational, not a template or a bullet list. Mention what was logged and the most relevant numbers, phrased like a person would say it, not a report line. Reply in the same language as the user's caption if one is given; otherwise reply in English.`;

function buildLogPrompt(kind: "meal" | "exercise", analysis: PhotoAnalysis, caption: string | null): string {
  const lines = [`Logged as: ${kind}.`, `Description: ${analysis.description}.`];
  if (kind === "meal") {
    if (analysis.estimatedCalories !== null) lines.push(`Estimated calories: ${analysis.estimatedCalories} kcal.`);
    if (analysis.proteinG !== null) lines.push(`Protein: ${analysis.proteinG}g.`);
    if (analysis.carbsG !== null) lines.push(`Carbs: ${analysis.carbsG}g.`);
    if (analysis.fatG !== null) lines.push(`Fat: ${analysis.fatG}g.`);
  } else {
    if (analysis.exerciseType) lines.push(`Exercise type: ${analysis.exerciseType}.`);
    if (analysis.durationMinutes !== null) lines.push(`Duration: ${analysis.durationMinutes} min.`);
    if (analysis.intensity) lines.push(`Intensity: ${analysis.intensity}.`);
    if (analysis.estimatedCaloriesBurned !== null) lines.push(`Estimated calories burned: ${analysis.estimatedCaloriesBurned} kcal.`);
  }
  if (caption) lines.push(`User's caption: "${caption}"`);
  return lines.join("\n");
}

export async function narrateLoggedEntry(kind: "meal" | "exercise", analysis: PhotoAnalysis, caption: string | null, signal?: AbortSignal): Promise<string> {
  const model = createNemotronModel("low");
  const response = await model.invoke(
    [
      { role: "system" as const, content: LOG_NARRATOR_SYSTEM_PROMPT },
      { role: "user" as const, content: buildLogPrompt(kind, analysis, caption) },
    ],
    { signal },
  );
  const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  return raw.trim();
}
