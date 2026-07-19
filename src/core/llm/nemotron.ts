import { ChatOpenAI } from "@langchain/openai";
import type { MessageContent } from "@langchain/core/messages";
import { config } from "../../config.js";

export type ThinkingMode = "off" | "low" | "full";

// langchain-core's default getNumTokens tries to load a tiktoken encoding
// for `this.modelName` before falling back to a chars/4 estimate — for any
// model name tiktoken doesn't recognize (every NVIDIA NIM model, including
// ours), that lookup always fails and logs a "Failed to calculate number of
// tokens" warning straight to console.warn on every single turn. Harmless
// (the fallback estimate is used either way — and NVIDIA's endpoint returns
// real usage on the stream's final chunk regardless, see streamUsage below),
// but noisy on interfaces that don't suppress raw console output (unlike the
// CLI's disableConsoleEcho or the web server's own terminal). Skip the
// doomed tiktoken attempt entirely by overriding the instance method with
// the same chars/4 approximation langchain-core falls back to anyway.
function toPlainText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" && "text" in part ? part.text : "")).join("");
}

export function createNemotronModel(thinkingMode: ThinkingMode = "full"): ChatOpenAI {
  const thinking = thinkingMode !== "off";

  const model = new ChatOpenAI({
    model: config.nemotronModel,
    apiKey: config.nvidiaApiKey,
    temperature: 1.0,
    topP: 0.95,
    modelKwargs: {
      chat_template_kwargs: {
        enable_thinking: thinking,
        ...(thinkingMode === "low" ? { low_effort: true } : {}),
      },
    },
    configuration: {
      baseURL: config.nemotronBaseUrl,
    },
    streaming: true,
    // Verified against the live NVIDIA endpoint: it does return real usage
    // on the final stream chunk (empty content, populated usage_metadata),
    // so this gets exact token counts instead of langchain's tiktoken-based
    // estimate — no "Unknown model" warning either, since real usage means
    // there's nothing to estimate.
    streamUsage: true,
  });
  model.getNumTokens = async (content) => Math.ceil(toPlainText(content).length / 4);
  return model;
}
