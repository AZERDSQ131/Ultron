import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createNemotronModel } from "../llm/nemotron.js";

const SYSTEM_PROMPT = `You are ULTRON, the user's personal agent.
You are currently in early development: conversation loop and memory only, no tools yet.
Respond directly and usefully, in English.`;

// Phase 3 will populate this. Kept empty for now so the agentic loop
// (agent <-> tools) is already wired and ready to receive real tools.
const tools: StructuredToolInterface[] = [];

function routeAfterAgent(state: typeof MessagesAnnotation.State) {
  const last = state.messages.at(-1) as AIMessage;
  if (last.tool_calls?.length) return "tools";
  return END;
}

export function buildGraph(checkpointer: PostgresSaver) {
  const baseModel = createNemotronModel();
  const model = tools.length > 0 ? baseModel.bindTools(tools) : baseModel;

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state, runConfig) => {
      const messages = [{ role: "system" as const, content: SYSTEM_PROMPT }, ...state.messages];
      // Forward runConfig so LangGraph's callback manager can intercept
      // per-token chunks for streamMode "messages".
      const response = await model.invoke(messages, runConfig);
      return { messages: [response] };
    })
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addEdge("tools", "agent");

  return graph.compile({ checkpointer });
}
