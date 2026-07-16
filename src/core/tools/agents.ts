import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config } from "../../config.js";
import { getChatRegistry } from "../memory/chats.js";
import { AgentRegistry } from "../memory/agents.js";
// Static import despite the cycle (graph.ts -> tools/index.ts -> this file
// -> graph.ts): buildGraph is a hoisted function declaration, so its binding
// exists before either module's top-level body finishes running, which is
// what makes this safe under ESM's circular-import rules. A dynamic
// import() would dodge the cycle too, but there is nothing to dodge here.
import { buildGraph, getPendingApproval } from "../graph.js";
import { beginRun } from "../runs.js";
import { withThreadLock } from "../threadLock.js";
import { summarizeToolCall } from "./summarize.js";

const agentsRegistry = new AgentRegistry(config.databasePath);
const chats = getChatRegistry(config.databasePath);

// buildGraph() wires a fresh StateGraph but shares the same singleton
// checkpointer (see checkpointer.ts) — still worth caching once per process
// instead of on every spawn_agent call.
let subGraph: ReturnType<typeof buildGraph> | undefined;
function getSubGraph(): ReturnType<typeof buildGraph> {
  if (!subGraph) subGraph = buildGraph();
  return subGraph;
}

// A spawned agent's own graph run has spawn_agent available too (same
// shared `tools` array as the parent), so this caps how deep that chain can
// go before a cost/latency runaway — not a security boundary (this project
// has none by design, see CLAUDE.md), just a sane default against a mistake
// compounding into a long, expensive chain no one is watching.
const MAX_SPAWN_DEPTH = 3;

function logError(prefix: string, err: unknown): void {
  console.error(`[ultron] ${prefix}:`, err instanceof Error ? err.stack ?? err.message : String(err));
}

// Runs the sub-agent to completion and, once it's done, wakes the thread
// that spawned it by appending a note and re-invoking that thread's graph —
// this is what makes it a real new ULTRON turn in the parent conversation
// (visible in its history, driven by SqliteSaver's shared checkpoint state)
// instead of a result silently sitting only in the sub-agent's own chat.
// Deliberately not awaited by the tool call itself (see spawnAgent below),
// so it must never throw — every failure path is reported back into the
// parent thread the same way a success would be.
async function runSpawnedAgent(opts: {
  parentThreadId: string;
  ownerName: string;
  executionChatId: string;
  task: string;
  thinking: "full" | "low" | "off";
  spawnDepth: number;
}): Promise<void> {
  const graph = getSubGraph();
  // Registers this chat as "running" (see runs.ts) so the web UI's Stop
  // button works on it and, if the user opens this chat while it's still
  // going, GET /api/chats/:id/stream (server.ts) can attach to `emit`'s
  // events instead of only showing whatever was there before the run
  // started — the same tool-call/text events a normal streamed turn emits.
  const run = beginRun(opts.executionChatId);
  let note: string;
  let aborted = false;

  try {
    // opts.ownerInstructions is not repeated here — the execution chat is
    // owned by this Agent, so graph.ts's buildAgentSystemPrompt already
    // gives it those instructions as its system prompt (and keeps it out of
    // ULTRON's own SOUL.md persona and memory).
    const prompt = `You were spawned by ULTRON to complete a specific task in your own conversation, separate from the one that spawned you. Work autonomously, use your tools as needed, and finish with a clear final report of what you did and the result — that final message is what gets relayed back to ULTRON and, through it, to the user.\n\nTask: ${opts.task}`;

    const stream = await graph.stream(
      { messages: [new HumanMessage(prompt)] },
      {
        configurable: { thread_id: opts.executionChatId, thinking: opts.thinking, spawnDepth: opts.spawnDepth },
        signal: run.signal,
        streamMode: "messages",
        recursionLimit: config.graphRecursionLimit,
      },
    );

    const pendingToolCalls = new Map<string | number, { name: string; args: string }>();
    for await (const [chunk] of stream) {
      const type = chunk.getType();

      if (type === "tool") {
        const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
        const pending = [...pendingToolCalls.values()].find((call) => call.name === toolName);
        if (pending) {
          run.emit({ type: "tool_call", name: pending.name, summary: summarizeToolCall(pending.name, pending.args) });
          const key = [...pendingToolCalls.entries()].find(([, call]) => call === pending)?.[0];
          if (key !== undefined) pendingToolCalls.delete(key);
        }
        run.emit({ type: "tool_result", name: toolName, content: String(chunk.content) });
        continue;
      }
      if (type !== "ai") continue;

      const toolCallChunks = (chunk as unknown as { tool_call_chunks?: { name?: string; args?: string; index?: number; id?: string }[] }).tool_call_chunks;
      if (toolCallChunks?.length) {
        for (const tc of toolCallChunks) {
          const key = tc.index ?? tc.id ?? tc.name ?? 0;
          const pending = pendingToolCalls.get(key) ?? { name: tc.name ?? "tool", args: "" };
          pending.name = tc.name ?? pending.name;
          pending.args += tc.args ?? "";
          pendingToolCalls.set(key, pending);
        }
        continue;
      }

      if (typeof chunk.content !== "string" || !chunk.content) continue;
      run.emit({ type: "text", delta: chunk.content });
    }

    // A non-"bypass" security mode (inherited from the parent chat, see
    // spawnAgent below) can pause the sub-agent mid-run on its own
    // toolsNode interrupt() (graph.ts) — the stream then simply ends
    // without a real final answer. Nobody is watching that chat to resolve
    // it on their own, so say so plainly instead of relaying whatever
    // half-formed message was left on top of the stack as a finished report.
    const pendingApproval = await getPendingApproval(graph, opts.executionChatId);
    if (pendingApproval) {
      note = `[spawn_agent] Agent "${opts.ownerName}" (chat ${opts.executionChatId}) is paused waiting for tool approval before it can continue (${pendingApproval.calls.map((c) => c.name).join(", ")}). It inherited this conversation's tool-approval mode. Open its chat to approve or deny, or tell the user it's waiting.`;
    } else {
      const state = await graph.getState({ configurable: { thread_id: opts.executionChatId } });
      const last = state.values.messages?.at(-1);
      const report = last && typeof last.content === "string" ? last.content : JSON.stringify(last?.content ?? "(no output)");
      note = `[spawn_agent] Agent "${opts.ownerName}" finished (chat ${opts.executionChatId}). Its report:\n\n${report}\n\nRelay the relevant result to the user now, in your own words.`;
    }
  } catch (err) {
    if (run.signal.aborted) {
      aborted = true;
      run.emit({ type: "aborted" });
      note = `[spawn_agent] Agent "${opts.ownerName}" (chat ${opts.executionChatId}) was stopped before finishing.`;
    } else {
      logError(`spawn_agent background run failed for agent=${opts.ownerName} chat=${opts.executionChatId}`, err);
      const message = err instanceof Error ? err.message : String(err);
      run.emit({ type: "error", message });
      note = `[spawn_agent] Agent "${opts.ownerName}" (chat ${opts.executionChatId}) failed before finishing: ${message}`;
    }
  } finally {
    if (!aborted) run.emit({ type: "done" });
    run.end();
  }

  try {
    console.error(`[ultron] spawn_agent waking parent thread=${opts.parentThreadId} agent=${opts.ownerName}`);
    // Serialized per parentThreadId (see threadLock.ts) — without this, a
    // sub-agent finishing while the user's own turn on that same chat was
    // still streaming (server.ts's streamGraphTurn, same lock) would race
    // it: two concurrent Pregel runs on one checkpoint thread, which is
    // exactly what produced stray tool/report text bleeding into the live
    // reply. This call now simply waits its turn instead.
    await withThreadLock(opts.parentThreadId, () =>
      graph.invoke(
        { messages: [new SystemMessage(note)] },
        { configurable: { thread_id: opts.parentThreadId, thinking: opts.thinking }, recursionLimit: config.graphRecursionLimit },
      ),
    );
    chats.touch(opts.parentThreadId);
  } catch (err) {
    logError(`spawn_agent could not wake parent thread=${opts.parentThreadId} agent=${opts.ownerName}`, err);
  }
}

export const spawnAgent = tool(
  async (
    { name, instructions, task, thinking }: { name: string; instructions?: string | null; task: string; thinking?: "full" | "low" | "off" | null },
    runConfig?: RunnableConfig,
  ) => {
    const depth = Number(runConfig?.configurable?.spawnDepth ?? 0);
    if (depth >= MAX_SPAWN_DEPTH) {
      return `error: spawn depth limit (${MAX_SPAWN_DEPTH}) reached — refusing to spawn another agent from inside a spawned agent's own run.`;
    }
    const parentThreadId = String(runConfig?.configurable?.thread_id ?? "");
    if (!parentThreadId) return "error: no active conversation to report back to.";

    try {
      const trimmedName = name.trim();
      if (!trimmedName) return "error: name is required";
      let owner = agentsRegistry.listAgents().find((a) => a.name.toLowerCase() === trimmedName.toLowerCase());
      if (!owner) {
        owner = agentsRegistry.createAgent(trimmedName, "", instructions?.trim() ?? "");
        console.error(`[ultron] spawn_agent created new Agent "${owner.name}" (${owner.id})`);
      } else if (instructions?.trim()) {
        owner = agentsRegistry.updateAgent(owner.id, { instructions: instructions.trim() }) ?? owner;
      }

      const execution = chats.create(`Agent: ${owner.name} — ${task.slice(0, 40)}`, owner.id);
      // Inherit the parent chat's tool-approval mode (see chats.ts) instead
      // of defaulting to "bypass" — a spawned agent has the same tool
      // access as ULTRON, so it should be no less supervised than the
      // conversation that spawned it.
      chats.setSecurityMode(execution.id, chats.getSecurityMode(parentThreadId));
      const effectiveThinking = thinking ?? "full";
      console.error(`[ultron] spawn_agent dispatching agent=${owner.name} chat=${execution.id} parent=${parentThreadId} depth=${depth}`);

      // Fire-and-forget: this tool call returns immediately so the current
      // turn isn't blocked for as long as the sub-agent takes to run (which
      // matters most when several are spawned at once). runSpawnedAgent
      // reports back into parentThreadId on its own once it's done — see
      // its doc comment.
      void runSpawnedAgent({
        parentThreadId,
        ownerName: owner.name,
        executionChatId: execution.id,
        task,
        thinking: effectiveThinking,
        spawnDepth: depth + 1,
      });

      return `Agent "${owner.name}" dispatched (chat ${execution.id}) and is now working in the background. You are NOT blocked on it — continue this turn (e.g. dispatch other agents, answer the rest of the user's message) without waiting. Its report will arrive as a new message in this same conversation once it finishes; react to it then.`;
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "spawn_agent",
    description:
      "Dispatch a sub-agent to handle a task in its own conversation and immediately return — it does NOT block. " +
      "The sub-agent has the same tools as ULTRON (including spawn_agent itself, up to a small depth limit) and runs " +
      "autonomously; when it finishes, its report is delivered back as a new message in THIS conversation, prompting " +
      "you to relay it to the user — you do not need to check on it or poll. Call this once per independent task " +
      "(e.g. three calls to research three different topics in parallel) rather than looping and waiting. Use it to " +
      "delegate self-contained work instead of doing it inline. Reusing an existing agent name resumes that Agent's " +
      "identity (and its saved instructions, unless new ones are given) but always starts a fresh conversation for " +
      "the task.",
    schema: z.object({
      name: z.string().describe("Short name for the agent, e.g. 'Researcher' or 'Refactor bot'. Reuses an existing Agent of this name if one exists."),
      instructions: z.string().nullable().optional().describe("Persona/system instructions for this agent. Only needed to set or change them; omit to reuse an existing agent's saved instructions."),
      task: z.string().describe("The exact task for the sub-agent to complete, with enough context to work independently."),
      thinking: z.enum(["full", "low", "off"]).nullable().optional().describe("Reasoning effort for the sub-agent's run. Defaults to full."),
    }),
  },
);
