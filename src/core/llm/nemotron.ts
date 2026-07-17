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
    // Verified against the live NVIDIA endpoint: it does return real usage
    // on the final stream chunk (empty content, populated usage_metadata),
    // so this gets exact token counts instead of langchain's tiktoken-based
    // estimate — no "Unknown model" warning either, since real usage means
    // there's nothing to estimate.
    streamUsage: true,
  });
}
