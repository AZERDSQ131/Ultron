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

// /computer-use uses a separate model from the main chat loop — bound to
// precise tool calls addressing accessibility-tree element paths rather
// than conversational text, so it gets a lower temperature and no
// reasoning/thinking kwargs (those are Nemotron/GLM chat-template
// specific, not something to assume of an arbitrary model id).
export function createComputerUseModel(modelId: string): ChatOpenAI {
  return new ChatOpenAI({
    model: modelId,
    apiKey: config.nvidiaApiKey,
    temperature: 0.2,
    configuration: {
      baseURL: config.nemotronBaseUrl,
    },
  });
}
