import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createNemotronModel } from "../llm/nemotron.js";

const SYSTEM_PROMPT = `Tu es ULTRON, l'agent personnel de l'utilisateur.
Tu es en phase de construction : boucle conversationnelle + memoire, sans outils pour l'instant.
Reponds de maniere directe et utile, en francais.`;

export function buildGraph(checkpointer: PostgresSaver) {
  const model = createNemotronModel();

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => {
      const messages = [{ role: "system" as const, content: SYSTEM_PROMPT }, ...state.messages];
      const response = await model.invoke(messages);
      return { messages: [response] };
    })
    .addEdge(START, "agent")
    .addEdge("agent", END);

  return graph.compile({ checkpointer });
}
