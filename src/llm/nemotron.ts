import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config.js";

export function createNemotronModel(): ChatOpenAI {
  return new ChatOpenAI({
    model: config.nemotronModel,
    apiKey: config.nvidiaApiKey,
    configuration: {
      baseURL: config.nemotronBaseUrl,
    },
  });
}
