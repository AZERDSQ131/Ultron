import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { AIMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createNemotronModel } from "../llm/nemotron.js";
import { runShellCommand } from "../tools/shell.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const soul = readFileSync(join(__dirname, "..", "..", "SOUL.md"), "utf-8");

const SYSTEM_PROMPT = `${soul}

---

Operational notes:
- You are early in development: loop, memory, and a first tool (run_shell_command) are wired up. More tools land in later phases.
- Respond in the language the user is writing in.

Reminder, because it's easy to slip: the voice and hard rules above apply to every message, including greetings and small talk. Do not fall back to generic assistant phrasing or emoji under any circumstance.`;

const tools: StructuredToolInterface[] = [runShellCommand];

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
