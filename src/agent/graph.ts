import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createNemotronModel } from "../llm/nemotron.js";

const SYSTEM_PROMPT = `You are ULTRON, the user's personal agent.
You are currently in early development: conversation loop and memory only, no tools yet.
Respond directly and usefully, in English.`;

export function buildGraph(checkpointer: PostgresSaver) {
  const model = createNemotronModel();

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state, runConfig) => {
      const messages = [{ role: "system" as const, content: SYSTEM_PROMPT }, ...state.messages];
      // Forward runConfig so LangGraph's callback manager can intercept
      // per-token chunks for streamMode "messages".
      const response = await model.invoke(messages, runConfig);
      return { messages: [response] };
    })
    .addEdge(START, "agent")
    .addEdge("agent", END);

  return graph.compile({ checkpointer });
}
