import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StateGraph, MessagesAnnotation, END, START } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessageLike } from "@langchain/core/messages";
import type { Runnable, RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { ZodObject, ZodRawShape } from "zod";
import { createNemotronModel } from "../llm/nemotron.js";
import { runShellCommand } from "../tools/shell.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const soul = readFileSync(join(__dirname, "..", "..", "SOUL.md"), "utf-8");

const SYSTEM_PROMPT = `${soul}

---

Operational notes:
- You are early in development: loop, memory, and a first tool (run_shell_command) are wired up. More tools land in later phases.
- Respond in the language the user is writing in.

Reminder, because it's easy to slip: the voice and hard rules above apply to every message, including greetings and small talk. Do not fall back to generic assistant phrasing or emoji under any circumstance.

Language, one more time because it's the easiest rule to drop under pressure: match the language of the user's most recent message, exactly, every time — regardless of which language any example above happens to use. If the user just wrote in French, reply in French even if the closest example in this prompt was in English.`;

const tools: StructuredToolInterface[] = [runShellCommand];

function routeAfterAgent(state: typeof MessagesAnnotation.State) {
  const last = state.messages.at(-1) as AIMessage;
  if (last.tool_calls?.length) return "tools";
  return END;
}

// The NVIDIA endpoint occasionally fails mid-stream with a transient
// worker-side overload (e.g. "ResourceExhausted: Worker local total
// request limit reached") that the OpenAI SDK's own retry logic doesn't
// catch, since it only covers the initial request, not stream errors.
const RETRYABLE_ERROR = /resourceexhausted|rate.?limit/i;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

async function invokeWithRetry(
  model: Runnable<BaseMessageLike[], AIMessage>,
  messages: BaseMessageLike[],
  runConfig: RunnableConfig,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await model.invoke(messages, runConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = RETRYABLE_ERROR.test(message);
      if (!retryable || attempt >= MAX_ATTEMPTS || runConfig.signal?.aborted) throw err;

      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.error(
        `[ultron] transient API error, retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS}): ${message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Nemotron occasionally "calls" a tool by writing its JSON arguments as
// plain reply text instead of using the real tool_calls mechanism — no
// tool actually runs, and (worse) that fake exchange gets saved to
// persistent history, where the model tends to imitate its own past
// behavior on later turns. Detect the pattern from each tool's own zod
// schema (so it generalizes as tools are added) and force a fresh retry
// rather than ever accepting or persisting a malformed "call".
const toolArgKeySets = tools.map(
  (t) => new Set(Object.keys((t.schema as ZodObject<ZodRawShape>).shape)),
);

function looksLikeFakeToolCall(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

  const keys = Object.keys(parsed);
  if (keys.length === 0) return false;
  return toolArgKeySets.some((argKeys) => keys.every((k) => argKeys.has(k)));
}

const MAX_FAKE_TOOL_CALL_RETRIES = 5;

// Once a fake tool call has been generated it lives on in persisted history
// (the checkpointer keeps every past turn on the single "ultron-main"
// thread), and the model tends to imitate its own recent bad behavior —
// the retry above alone isn't enough once a few of these have accumulated.
// Scrub qualifying messages out of the prompt on every turn so old
// pollution can't keep re-poisoning new generations.
function sanitizeHistory(messages: BaseMessageLike[]): BaseMessageLike[] {
  return messages.filter((m) => {
    if (!(m instanceof AIMessage)) return true;
    if (m.tool_calls?.length) return true;
    return !looksLikeFakeToolCall(m.content);
  });
}

export function buildGraph(checkpointer: PostgresSaver) {
  const baseModel = createNemotronModel();
  const model = tools.length > 0 ? baseModel.bindTools(tools) : baseModel;

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state, runConfig) => {
      const messages = [
        { role: "system" as const, content: SYSTEM_PROMPT },
        ...sanitizeHistory(state.messages),
      ];
      // Forward runConfig so LangGraph's callback manager can intercept
      // per-token chunks for streamMode "messages".
      let response = await invokeWithRetry(model, messages, runConfig);

      let attempt = 1;
      while (
        !response.tool_calls?.length &&
        looksLikeFakeToolCall(response.content) &&
        attempt < MAX_FAKE_TOOL_CALL_RETRIES
      ) {
        attempt++;
        console.error(
          `[ultron] model wrote a tool call as plain text instead of using it — discarding and retrying (attempt ${attempt}/${MAX_FAKE_TOOL_CALL_RETRIES})`,
        );
        response = await invokeWithRetry(model, messages, runConfig);
      }

      // Never surface a fabricated tool call/result as if it were a real
      // answer — after exhausting retries, replace it with an explicit
      // failure notice instead of passing fiction through as fact.
      if (!response.tool_calls?.length && looksLikeFakeToolCall(response.content)) {
        console.error(
          `[ultron] gave up after ${MAX_FAKE_TOOL_CALL_RETRIES} attempts — the model never issued a real tool call for this turn.`,
        );
        response = new AIMessage(
          "[ultron] Tool call failed to register after several attempts — I'm not going to guess at the answer. Ask again.",
        );
      }

      return { messages: [response] };
    })
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addEdge("tools", "agent");

  return graph.compile({ checkpointer });
}
