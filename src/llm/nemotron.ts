import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config.js";

export function createNemotronModel(): ChatOpenAI {
  return new ChatOpenAI({
    model: config.nemotronModel,
    apiKey: config.nvidiaApiKey,
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
