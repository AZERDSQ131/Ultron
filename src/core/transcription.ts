import { config } from "../config.js";

export async function transcribeAudio(input: { buffer: Buffer; filename: string; mimeType: string; language?: string }): Promise<string> {
  if (!config.mistralApiKey) throw new Error("MISTRAL_API_KEY is not configured");

  const form = new FormData();
  form.append("model", config.mistralTranscriptionModel);
  form.append("file", new Blob([input.buffer], { type: input.mimeType }), input.filename);
  if (input.language) form.append("language", input.language);

  const response = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.mistralApiKey}` },
    body: form,
  });
  const body = await response.json() as { text?: string; message?: string; detail?: string };
  if (!response.ok) throw new Error(body.message ?? body.detail ?? `Mistral transcription failed (${response.status})`);
  if (!body.text?.trim()) throw new Error("Mistral returned an empty transcription");
  return body.text.trim();
}
