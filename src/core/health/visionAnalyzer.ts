import { createVisionModel } from "../llm/nemotron.js";
import { recordUsage } from "../llm/usage.js";
import { config } from "../../config.js";

// Turns a meal/exercise photo into structured data — same "separate cheap
// LLM call fed only what it needs" pattern as narrator.ts/goalJudge.ts, but
// multimodal: the photo (as a data URL) plus the user's optional caption.
// The model itself classifies meal vs exercise vs neither, rather than the
// caller guessing from a keyword in the caption — a photo of a plate is
// unambiguous to a vision model and this avoids a brittle keyword list.

export interface PhotoAnalysis {
  kind: "meal" | "exercise" | "unrecognized";
  description: string;
  // meal fields
  estimatedCalories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  // exercise fields
  exerciseType: string | null;
  durationMinutes: number | null;
  intensity: string | null;
  estimatedCaloriesBurned: number | null;
}

const ANALYZER_SYSTEM_PROMPT = `You analyze a single photo the user sent to their personal health log: either a meal/food photo or a photo related to exercise (a workout screen, gym equipment, a run route, etc). You may also get a short caption from the user — trust it over your own guess when it conflicts with what the photo shows.

Reply with exactly one JSON object on a single line, nothing else. Use this shape:
{"kind":"meal","description":"<one short sentence>","estimatedCalories":<number|null>,"proteinG":<number|null>,"carbsG":<number|null>,"fatG":<number|null>,"exerciseType":null,"durationMinutes":null,"intensity":null,"estimatedCaloriesBurned":null}
or
{"kind":"exercise","description":"<one short sentence>","estimatedCalories":null,"proteinG":null,"carbsG":null,"fatG":null,"exerciseType":"<e.g. running, weights, cycling>","durationMinutes":<number|null>,"intensity":"<low|moderate|high|null>","estimatedCaloriesBurned":<number|null>}
or, if the photo is neither a meal nor exercise-related:
{"kind":"unrecognized","description":"<what you actually see>","estimatedCalories":null,"proteinG":null,"carbsG":null,"fatG":null,"exerciseType":null,"durationMinutes":null,"intensity":null,"estimatedCaloriesBurned":null}

Rules:
- All numeric estimates are rough visual guesses, not lab measurements — give your best plausible estimate rather than null whenever the photo gives you enough to go on, but use null when you truly can't tell.
- Never invent exact-looking precision (e.g. don't say 47g protein from a photo alone) — round to sensible increments.
- description is one short, plain sentence, no medical or diagnostic language.`;

function parseAnalysis(raw: string): PhotoAnalysis {
  const match = raw.trim().match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : raw.trim();
  const data = JSON.parse(jsonText) as Partial<PhotoAnalysis>;
  const kind = data.kind === "meal" || data.kind === "exercise" ? data.kind : "unrecognized";
  return {
    kind,
    description: typeof data.description === "string" && data.description.trim() ? data.description.trim() : "No description.",
    estimatedCalories: typeof data.estimatedCalories === "number" ? data.estimatedCalories : null,
    proteinG: typeof data.proteinG === "number" ? data.proteinG : null,
    carbsG: typeof data.carbsG === "number" ? data.carbsG : null,
    fatG: typeof data.fatG === "number" ? data.fatG : null,
    exerciseType: typeof data.exerciseType === "string" ? data.exerciseType : null,
    durationMinutes: typeof data.durationMinutes === "number" ? data.durationMinutes : null,
    intensity: typeof data.intensity === "string" ? data.intensity : null,
    estimatedCaloriesBurned: typeof data.estimatedCaloriesBurned === "number" ? data.estimatedCaloriesBurned : null,
  };
}

export async function analyzeHealthPhoto(imageBase64: string, mimeType: string, caption: string | undefined, signal?: AbortSignal): Promise<PhotoAnalysis> {
  const model = createVisionModel();
  const started = Date.now();
  const response = await model.invoke(
    [
      { role: "system" as const, content: ANALYZER_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: [
          { type: "image_url" as const, image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: "text" as const, text: caption?.trim() ? `Caption: ${caption.trim()}` : "No caption given." },
        ],
      },
    ],
    { signal },
  );
  recordUsage("vision", null, config.visionModel, response.usage_metadata?.input_tokens ?? 0, response.usage_metadata?.output_tokens ?? 0, Date.now() - started, "nvidia");
  const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  return parseAnalysis(raw);
}
