import { ChatOpenAI } from "@langchain/openai";
import { config } from "../../config.js";

export type ThinkingMode = "off" | "low" | "full";

export function createNemotronModel(thinkingMode: ThinkingMode = "full"): ChatOpenAI {
  const thinking = thinkingMode !== "off";

  return new ChatOpenAI({
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
    // NVIDIA's endpoint doesn't return usage in the stream; without this,
    // langchain falls back to a tiktoken-based estimate and logs a noisy
    // "Unknown model" warning on every reply.
    streamUsage: false,
  });
}
