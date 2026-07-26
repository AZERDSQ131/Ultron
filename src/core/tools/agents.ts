import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config } from "../../config.js";
import { getChatRegistry } from "../memory/chats.js";
// Static import despite the cycle (graph.ts -> tools/index.ts -> this file ->
// graph.ts): buildGraph and messageContentToText are hoisted function
// declarations, so their bindings exist before either module's top-level body
// finishes running, which is what makes this safe under ESM's circular-import
// rules.
import { buildGraph, messageContentToText } from "../graph.js";
import { log } from "../logger.js";

const chats = getChatRegistry(config.databasePath);

// buildGraph() wires a fresh StateGraph but shares the singleton checkpointer,
// so a sub-agent's conversation persists in the same database as everything
// else — that's what makes it openable after the fact. Cached once per process
// rather than rebuilt per spawn.
let subGraph: ReturnType<typeof buildGraph> | undefined;
function getSubGraph(): ReturnType<typeof buildGraph> {
  if (!subGraph) subGraph = buildGraph();
  return subGraph;
}

// A sub-agent's own run has spawn_agent available too (same shared `tools`
// array), so this caps how deep the chain can go. Not a security boundary —
// this project has none by design — just a guard against one mistake
// compounding into a long, expensive chain nobody is watching.
const MAX_SPAWN_DEPTH = 2;

// Marker prefixed to the tool result so the clients can turn a spawn_agent
// call into a link to the conversation it created. It has to travel in the
// result text rather than an out-of-band event because the same parsing has to
// work when history is replayed from GET /api/chats/:id/messages, not just on
// the live SSE stream.
const SUBAGENT_MARKER = /^\[ultron:subagent chat=([0-9a-f-]+)\]/;

export function parseSubAgentMarker(content: string): string | null {
  return SUBAGENT_MARKER.exec(content.trimStart())?.[1] ?? null;
}

// Every in-flight sub-agent run, keyed by the chat that spawned it. Stopping a
// conversation has to stop the work it delegated, or the user presses Stop, the
// transcript goes quiet, and sub-agents keep burning tokens invisibly.
const runningByParent = new Map<string, Map<string, AbortController>>();

function registerRun(parentChatId: string, childChatId: string, controller: AbortController): void {
  const existing = runningByParent.get(parentChatId);
  if (existing) existing.set(childChatId, controller);
  else runningByParent.set(parentChatId, new Map([[childChatId, controller]]));
}

function unregisterRun(parentChatId: string, childChatId: string): void {
  const existing = runningByParent.get(parentChatId);
  if (!existing) return;
  existing.delete(childChatId);
  if (!existing.size) runningByParent.delete(parentChatId);
}

/// Aborts every sub-agent spawned by `chatId`, and recursively everything they
/// spawned in turn — a sub-agent can spawn its own, so stopping the top-level
/// conversation has to cascade the whole way down rather than orphaning
/// grandchildren.
export function abortSubAgents(chatId: string): number {
  let stopped = 0;
  const direct = runningByParent.get(chatId);
  if (direct) {
    for (const [childChatId, controller] of [...direct]) {
      stopped += abortSubAgents(childChatId);
      controller.abort();
      stopped += 1;
    }
  }
  return stopped;
}

export function activeSubAgentIds(chatId: string): string[] {
  return [...(runningByParent.get(chatId)?.keys() ?? [])];
}

export const spawnAgent = tool(
  async ({ task, label }: { task: string; label?: string | null }, runConfig?: RunnableConfig) => {
    const parentChatId = runConfig?.configurable?.thread_id;
    if (typeof parentChatId !== "string") return "error: no active chat to spawn a sub-agent from";
    if (!task.trim()) return "error: task is empty — describe what the sub-agent should actually do";

    const depth = Number(runConfig?.configurable?.spawnDepth ?? 0);
    if (depth >= MAX_SPAWN_DEPTH) {
      return `error: sub-agent depth limit reached (${MAX_SPAWN_DEPTH}). Do this part of the work yourself instead of delegating further.`;
    }

    const title = (label?.trim() || task.trim()).slice(0, 60);
    const child = chats.createSubAgent(parentChatId, title, task.trim());

    const controller = new AbortController();
    registerRun(parentChatId, child.id, controller);
    // Two paths can cancel this: an explicit /api/stop on the parent
    // (abortSubAgents above) and the parent's own run being aborted, which
    // propagates its signal down into this tool call.
    const parentSignal = runConfig?.signal;
    const onParentAbort = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const prompt = `You were spawned by ULTRON as a sub-agent, to complete one specific task in your own separate conversation. Work autonomously — you cannot ask the user anything, and nobody will reply to you here. Use your tools as needed. Finish with a clear, self-contained report of what you did and what you found: that final message is the only thing handed back to the conversation that spawned you.\n\nTask: ${task.trim()}`;

      const result = await getSubGraph().invoke(
        { messages: [new HumanMessage(prompt)] },
        {
          configurable: {
            thread_id: child.id,
            thinking: runConfig?.configurable?.thinking ?? "full",
            spawnDepth: depth + 1,
            subAgent: true,
          },
          signal: controller.signal,
          recursionLimit: config.graphRecursionLimit,
        },
      );

      const messages = (result as { messages?: unknown[] }).messages ?? [];
      const finalText = messageContentToText((messages.at(-1) as { content?: unknown } | undefined)?.content).trim();
      const report = finalText || "(the sub-agent finished without producing a final report)";
      return `[ultron:subagent chat=${child.id}]\nSub-agent "${title}" finished.\n\n${report}`;
    } catch (err) {
      const aborted = controller.signal.aborted;
      const detail = err instanceof Error ? err.message : String(err);
      log("agents", `sub-agent ${child.id} ${aborted ? "aborted" : "failed"}: ${detail}`);
      return aborted
        ? `[ultron:subagent chat=${child.id}]\nSub-agent "${title}" was stopped before finishing. Its conversation is still readable.`
        : `[ultron:subagent chat=${child.id}]\nSub-agent "${title}" failed: ${detail}`;
    } finally {
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
      unregisterRun(parentChatId, child.id);
    }
  },
  {
    name: "spawn_agent",
    description:
      "Delegate one self-contained piece of work to a sub-agent, which runs in its own separate conversation with " +
      "the same tools you have and hands back a final report. Its conversation is preserved and the user can open " +
      "it to watch, so this is also how you keep a long side-investigation out of this transcript. " +
      "Issue SEVERAL spawn_agent calls in the SAME reply to run them in parallel — that is the main reason to use " +
      "this at all, and it is what makes a multi-part research or audit task finish in one pass instead of several. " +
      "Each task must be genuinely independent, since sub-agents cannot see each other's work or ask you anything " +
      "mid-run; give each one every detail it needs up front, and do the parts that depend on their results " +
      "yourself once the reports come back. Don't delegate something you could just do in one or two tool calls.",
    schema: z.object({
      task: z
        .string()
        .describe(
          "The complete, self-contained assignment. The sub-agent sees only this — not your conversation — so " +
            "include the context, constraints and what its report should contain.",
        ),
      // .nullable() alongside .optional() for OpenAI's strict function-calling
      // schemas — see the note in todos.ts's todo_update.
      label: z.string().nullable().optional().describe("Short name for this sub-agent, used as its conversation title in the UI."),
    }),
  },
);
