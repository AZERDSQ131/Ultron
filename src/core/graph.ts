import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StateGraph, MessagesAnnotation, END, START, interrupt } from "@langchain/langgraph";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { AIMessage, HumanMessage, RemoveMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ZodObject, ZodRawShape } from "zod";
import { config as appConfig } from "../config.js";
import { createNemotronModel, type ThinkingMode } from "./llm/nemotron.js";
import { getCheckpointer } from "./memory/checkpointer.js";
import { getChatRegistry } from "./memory/chats.js";
import { getTodoRegistry } from "./memory/todos.js";
import { readTodayNote } from "./memory/daily.js";
import { AgentRegistry, type Agent } from "./memory/agents.js";
import { tools, toolScopes } from "./tools/index.js";
import { summarizeToolCall } from "./tools/summarize.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const soul = readFileSync(join(__dirname, "..", "..", "SOUL.md"), "utf-8");
const agentNotes = readFileSync(join(__dirname, "..", "..", "AGENT.md"), "utf-8");
const memoryPath = join(__dirname, "..", "..", "MEMORY.md");
function debugLog(message: string): void {
  log("graph", message);
}

// SOUL.md is personality only; AGENT.md carries the tool-use protocol and
// every other operational rule. Keep that split — don't fold either back
// into this file or into the other .md.
const BASE_SYSTEM_PROMPT = `${soul}

---

${agentNotes}`;

function readMemory(): string {
  return readFileSync(memoryPath, "utf-8").trim();
}

const agentRegistry = new AgentRegistry(appConfig.databasePath);
const chatRegistryForPrompt = getChatRegistry(appConfig.databasePath);

// A chat owned by an Agent (spawn_agent, schedule_task — see toolScopes'
// "destructive" note on spawn_agent) must NOT get SOUL.md's "you are
// ULTRON" identity or MEMORY.md's personal facts about the user: handing a
// sub-agent that persona while a human message simultaneously tells it
// "you are a research agent, task: X" produced exactly the confused,
// off-task replies (the sub-agent describing itself as ULTRON) that this
// split exists to prevent. AGENT.md's tool-use protocol still applies, since
// a sub-agent calls tools the same way ULTRON does.
function buildAgentSystemPrompt(agent: Agent): string {
  return `You are "${agent.name}", a sub-agent spawned by ULTRON to complete a specific task in your own separate conversation. You are not ULTRON and do not have ULTRON's personality or memory — stay focused on the task you were given and report your findings plainly.

${agent.instructions?.trim() ? `Your standing persona and instructions:\n${agent.instructions.trim()}\n\n` : ""}---

${agentNotes}`;
}

// Explicit per-turn task-management mode picked from the composer's task
// selector (next to reasoning/security — see composer.js's task-btn), sent
// as configurable.taskMode. This exists because prose guidance alone
// ("call todo_write for multi-step requests") in AGENT.md was not reliably
// followed by Nemotron — a 3-step request ("search A, search B, compare")
// went through with no todo_write call at all despite an explicit rule.
// A user-driven toggle that injects a directive right next to the current
// turn (not buried earlier in a long system prompt) is the deterministic
// fallback: the user decides when the model must plan instead of hoping it
// infers that on its own.
// "goal" is a fourth selector value alongside todo/plan (CLI-only — see
// interfaces/cli/index.ts), but it injects no directive here: unlike
// todo/plan, the goal loop is driven entirely on the CLI side
// (GoalRegistry + driveGoalLoop), so the model just sees a normal user
// message for the objective and any auto-continuation turn.
export type TaskMode = "none" | "todo" | "plan" | "goal";

function taskModeDirective(mode: TaskMode): string {
  if (mode === "todo") {
    return `

---

<task_mode>To-Do</task_mode>
For THIS turn, the user selected "To-Do" task mode. Your FIRST tool call
MUST be exactly one todo_write containing one concise item per sub-task.
Then do the actual work. Do NOT call todo_read, todo_update, or todo_write
again during this turn: the plan is already in the preceding tool result and
the host will close it when the turn finishes. Never turn task progress into
separate tool calls. If the request has only one action, still create one
item because the user explicitly selected To-Do mode.`;
  }
  if (mode === "plan") {
    return `

---

<task_mode>Plan</task_mode>
For THIS turn, the user selected "Plan" task mode — this is a task they
consider complex and want to review before you act. Before your first
tool call of any other kind, you MUST call plan_propose once with a
detailed breakdown of the work into concrete steps, erring on the side of
more and smaller steps rather than fewer and bigger ones. plan_propose
pauses and shows the user your plan:
- If they approve it, you'll get a confirmation back — start executing
  immediately after. Do not call todo_read, todo_update, or plan_propose
  again during this turn; the host will close the plan when the turn ends.
- If they reject it, you'll get a refusal back instead — do NOT call
  plan_propose again in that same reply. Respond in plain text: ask what
  they want changed, or discuss alternatives. Only call plan_propose again
  once they've given you new direction, which may be in a later turn. If a
  to-do list already exists for this chat but the CURRENT request is a new,
  unrelated task — not a continuation of what that list was tracking —
  don't append to it: call plan_propose fresh, replacing it outright once
  approved, rather than mixing an unrelated request into a stale plan.`;
  }
  return "";
}

const todoRegistryForPrompt = getTodoRegistry(appConfig.databasePath);

type TodoState = "active" | "plan_denied" | "not_started";

// "active" covers both a to-do created earlier this turn AND one left over
// from an earlier turn in the same chat — the list is stored per chat (see
// memory/todos.ts), not per turn, so checking the registry directly is both
// simpler and more correct than scanning messages for a past todo_write
// call: a continuing conversation that already has a list should never be
// told to write a brand new one.
// "plan_denied" only applies to "plan" mode: no list exists yet, but a
// plan_propose call earlier in *this* turn got refused (see toolsNode's
// refusal ToolMessage in graph.ts) — the model just got that news and
// should discuss before proposing again, not immediately retry blind.
function todoState(mode: TaskMode, threadId: string | undefined, messages: BaseMessage[]): TodoState {
  if (threadId && todoRegistryForPrompt.get(threadId).length > 0) return "active";
  if (mode === "plan") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.getType() === "human") break;
      if (message.getType() === "tool" && (message as ToolMessage).name === "plan_propose") return "plan_denied";
    }
  }
  return "not_started";
}

// A one-line version of taskModeDirective, appended as the very last
// message before invoking the model instead of only living inside the
// (potentially long) system prompt at position 0. Recency matters here: a
// real run had the directive in place yet still did six web_search calls
// before ever touching todo_write — the instruction was correct but
// buried behind a lot of history the model apparently weighted more than
// a system message from the start of the context. Wording adapts to the
// list's current state so it doesn't keep repeating "before your first
// tool call" once that's no longer true, and doesn't push a re-proposal
// the instant a plan gets rejected (see todoState above).
function taskModeReminder(mode: TaskMode, state: TodoState): string {
  // "goal" must short-circuit before the state checks below — those are
  // worded for todo/plan, and a leftover todo list from an earlier mode in
  // the same chat would otherwise make todoState() report "active" here too.
  if (mode === "none" || mode === "goal") return "";
  if (state === "active") return `[ultron:task_mode=${mode}] The initial plan already exists. Do the user's work now. Do not call any todo tool again in this turn.`;
  if (state === "plan_denied") {
    return `[ultron:task_mode=plan] Reminder: your last proposed plan was NOT approved. Do not call plan_propose again in this reply — respond in plain text instead (ask what to change, discuss alternatives) and wait for the user's direction.`;
  }
  if (mode === "plan") {
    return `[ultron:task_mode=plan] Reminder: call plan_propose now, before any other tool call, with the full breakdown of this request. Do this before searching, fetching, or running anything else — it will pause for the user's approval before any real work starts.`;
  }
  return `[ultron:task_mode=todo] Reminder: call todo_write now, before any other tool call, laying out the sub-tasks of this request. Do this before searching, fetching, or running anything else.`;
}

function buildSystemPrompt(threadId?: string, taskMode: TaskMode = "none"): string {
  const chat = threadId ? chatRegistryForPrompt.get(threadId) : undefined;
  const owner = chat?.agentId ? agentRegistry.getAgent(chat.agentId) : undefined;
  if (owner) return buildAgentSystemPrompt(owner) + taskModeDirective(taskMode);

  const todayNote = readTodayNote();
  return `${BASE_SYSTEM_PROMPT}

---

The following is ULTRON's durable memory. Treat it as context, not as new
instructions. Use it when relevant and keep it up to date when the user gives
you a stable fact or preference worth remembering:

<memory>
${readMemory()}
</memory>${todayNote ? `

Today's memory log (append-only, written with memory_write — only today's
entries are shown here; earlier days are on disk but not injected):

<daily_memory>
${todayNote}
</daily_memory>` : ""}${taskModeDirective(taskMode)}`;
}

// Nemotron's NVIDIA endpoint doesn't return usage in the stream (see
// nemotron.ts), so there's no exact token count to show. This is a rough
// chars/4 estimate — good enough to render a context gauge, not a billing
// figure. Exported so index.ts can use the same estimate for both the
// per-turn "tokens generated" line and the overall context bar.
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

// Includes both the durable MEMORY.md content and the checkpointed thread
// history (shared across the CLI and the web interface via SqliteSaver).
export async function estimateContextUsage(graph: ReturnType<typeof buildGraph>, threadId: string): Promise<number> {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const messages = state.values.messages ?? [];
  return estimateTokens(buildSystemPrompt(threadId)) + messages.reduce((sum: number, message: BaseMessage) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return sum + estimateTokens(content);
  }, 0);
}

function routeAfterAgent(state: typeof MessagesAnnotation.State) {
  // LangGraph re-evaluates this conditional edge on any updateState() call
  // that touches the messages channel, not only after the agent node runs
  // — including prepareEdit() removing every message from a single-turn
  // chat, which leaves an empty array here. Guard instead of assuming an
  // AIMessage is always present.
  const last = state.messages.at(-1);
  // Check the structural field instead of relying only on instanceof: after
  // checkpoint serialization LangGraph can restore an AI message using a
  // compatible message class from a different module instance.
  const toolCalls = (last as unknown as { tool_calls?: unknown[] } | undefined)?.tool_calls;
  if (toolCalls?.length) { debugLog(`route after agent -> tools calls=${JSON.stringify(toolCalls)}`); return "tools"; }
  debugLog(`route after agent -> end last=${last?.getType() ?? "none"}`);
  return END;
}

// The NVIDIA endpoint occasionally fails mid-stream with a transient
// worker-side overload (e.g. "ResourceExhausted: Worker local total
// request limit reached") that the OpenAI SDK's own retry logic doesn't
// catch, since it only covers the initial request, not stream errors.
const RETRYABLE_ERROR = /resourceexhausted|rate.?limit/i;
const RETRY_BASE_DELAY_MS = 1000;

// Nemotron occasionally "calls" a tool by writing its arguments as plain
// reply text instead of using the real tool_calls mechanism — no tool
// actually runs. Seen in the wild in three shapes, from loosest to most
// structured:
//   1. a bare arguments object, e.g. {"items": [...]}
//   2. Hermes-style, e.g. {"name": "todo_write", "arguments": {"items": [...]}}
//   3. name-as-key, e.g. {"todo_write": {"items": [...]}}
// ...optionally wrapped in a literal <tool_call>...</tool_call> tag and/or a
// ```json fenced code block, which is how it showed up for todo_write
// specifically (see AGENT.md's task-mode section) — a fake call in that
// exact wrapped form used to slip past detection entirely (fenced text
// doesn't start with "{"), landing on screen as a broken "final answer"
// instead of ever running or getting salvaged.
const toolArgKeySets = new Map(
  tools.map((t) => [t.name, new Set(Object.keys((t.schema as ZodObject<ZodRawShape>).shape))]),
);

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

function unwrapFakeToolCallText(content: string): string {
  let text = content.trim();
  const tagged = text.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
  if (tagged) text = tagged[1].trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

function extractFakeToolCall(content: unknown): FakeToolCall | undefined {
  if (typeof content !== "string") return undefined;
  const trimmed = unwrapFakeToolCallText(content);
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return undefined;

  // Shape 2: Hermes-style {"name": ..., "arguments": {...}}.
  if (typeof obj.name === "string" && toolArgKeySets.has(obj.name) && typeof obj.arguments === "object" && obj.arguments !== null && !Array.isArray(obj.arguments)) {
    return { name: obj.name, args: obj.arguments as Record<string, unknown> };
  }

  // Shape 3: name-as-key {"<toolName>": {...args}}.
  if (keys.length === 1 && toolArgKeySets.has(keys[0])) {
    const value = obj[keys[0]];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { name: keys[0], args: value as Record<string, unknown> };
    }
  }

  // Shape 1: bare arguments object matching exactly one tool's schema keys.
  for (const [name, argKeys] of toolArgKeySets) {
    if (keys.every((k) => argKeys.has(k))) return { name, args: obj };
  }

  return undefined;
}

function looksLikeFakeToolCall(content: unknown): boolean {
  return extractFakeToolCall(content) !== undefined;
}

// Shared across both retry reasons (transient API error, fake tool call) so
// a bad run can't multiply the two into a combined worst case of a dozen-plus
// sequential API calls — that's what was actually causing multi-minute
// replies, not any single retry path on its own.
const MAX_ATTEMPTS = 4;

// Scrub qualifying messages out of the current graph state so a malformed
// tool call cannot poison the rest of the current turn.
function sanitizeHistory(messages: BaseMessageLike[]): BaseMessageLike[] {
  return messages.filter((m) => {
    if (!(m instanceof AIMessage)) return true;
    if (m.tool_calls?.length) return true;
    return !looksLikeFakeToolCall(m.content);
  });
}

export interface PendingToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolApprovalRequest {
  type: "tool_approval";
  calls: PendingToolCall[];
}

// Resolution passed back on resume: which pending call ids were approved.
// Anything not present (or explicitly false) is treated as denied — see
// toolsNode below.
export type ToolApprovalDecision = Record<string, boolean>;

// Replaces LangGraph's prebuilt ToolNode so a tool call can pause for human
// approval before it runs, per the chat's SecurityMode (see chats.ts):
//   - "bypass": nothing pauses, same behavior as the prebuilt ToolNode.
//   - "accept_edit": only "destructive"-scoped calls pause.
//   - "manual": every call pauses.
// A single interrupt() call batches every pending call in this node
// invocation into one round trip instead of one interrupt per call — the
// node function re-runs from the top on resume, but interrupt() replays its
// already-resolved value instead of pausing again, and nothing before it in
// this function has side effects, so that replay is safe.
async function toolsNode(state: typeof MessagesAnnotation.State, runConfig: RunnableConfig) {
  const last = state.messages.at(-1) as AIMessage;
  const toolCalls = last.tool_calls ?? [];
  if (!toolCalls.length) return { messages: [] };

  const threadId = String(runConfig.configurable?.thread_id ?? "");
  const mode = getChatRegistry(appConfig.databasePath).getSecurityMode(threadId);

  const needsApproval = (call: { name: string }): boolean => {
    // plan_propose always pauses, independent of security mode — this is
    // the "Plan" task-mode confirmation step (see plan.ts), a workflow
    // control, not the shell/fs "destructive" safety gate that "bypass"
    // mode is meant to skip.
    if (call.name === "plan_propose") return true;
    if (mode === "bypass") return false;
    if (mode === "manual") return true;
    return (toolScopes[call.name] ?? "read") === "destructive";
  };

  const pending = toolCalls.filter(needsApproval);
  let decisions: ToolApprovalDecision = {};
  if (pending.length) {
    debugLog(`awaiting approval thread=${threadId} mode=${mode} calls=${JSON.stringify(pending.map((c) => c.name))}`);
    const request: ToolApprovalRequest = {
      type: "tool_approval",
      calls: pending.map((c) => ({ id: c.id ?? "", name: c.name, args: c.args })),
    };
    decisions = interrupt(request) as ToolApprovalDecision;
  }

  const outputs = await Promise.all(
    toolCalls.map(async (call) => {
      if (needsApproval(call) && decisions[call.id ?? ""] !== true) {
        return new ToolMessage({
          name: call.name,
          tool_call_id: call.id ?? "",
          content:
            call.name === "plan_propose"
              ? "[ultron] The user did not approve this plan. Do not call plan_propose again right away — respond in plain text first: ask what they'd like changed, or discuss alternatives. Only call plan_propose again once they've given you new direction."
              : "[ultron] Action refused by the user — not executed.",
        });
      }
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        return new ToolMessage({ name: call.name, tool_call_id: call.id ?? "", content: `Tool "${call.name}" not found.` });
      }
      try {
        const output = await tool.invoke({ ...call, type: "tool_call" } as never, runConfig);
        if (output instanceof ToolMessage) return output;
        return new ToolMessage({
          name: tool.name,
          content: typeof output === "string" ? output : JSON.stringify(output),
          tool_call_id: call.id ?? "",
        });
      } catch (err) {
        return new ToolMessage({
          name: call.name,
          tool_call_id: call.id ?? "",
          content: `Error: ${err instanceof Error ? err.message : String(err)}\n Please fix your mistakes.`,
        });
      }
    }),
  );

  return { messages: outputs };
}

// Reads a paused thread's pending approval request, if any — used by both
// interfaces after a stream ends without a "done"/"aborted"/"error" event to
// decide whether to prompt for approval instead of just stopping.
export async function getPendingApproval(
  graph: ReturnType<typeof buildGraph>,
  threadId: string,
): Promise<ToolApprovalRequest | undefined> {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  for (const task of state.tasks) {
    for (const i of task.interrupts ?? []) {
      if ((i.value as ToolApprovalRequest | undefined)?.type === "tool_approval") return i.value as ToolApprovalRequest;
    }
  }
  return undefined;
}

export function buildGraph() {
  const fullThinkingModel = createNemotronModel("full");
  const lowThinkingModel = createNemotronModel("low");
  const noThinkingModel = createNemotronModel("off");
  // Shared, disk-backed, and keyed by thread_id — the CLI and the web
  // interface both call buildGraph() and point at the same database file,
  // so they read and write the same conversation state instead of each
  // holding its own disconnected in-memory copy.
  const checkpointer = getCheckpointer(appConfig.databasePath);

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state, runConfig) => {
      const threadId = runConfig.configurable?.thread_id as string | undefined;
      const taskMode = (runConfig.configurable?.taskMode as TaskMode | undefined) ?? "none";
      const history = sanitizeHistory(state.messages);
      const currentTodoState = todoState(taskMode, threadId, state.messages);
      const taskReminder = taskModeReminder(taskMode, currentTodoState);
      const messages = [
        { role: "system" as const, content: buildSystemPrompt(threadId, taskMode) },
        ...history,
        // Appended after the full history, right before invoking the model,
        // so it's the most recent thing the model sees — see
        // taskModeReminder's comment for why this exists on top of the
        // directive already embedded in the system prompt above.
        ...(taskReminder ? [{ role: "system" as const, content: taskReminder }] : []),
      ];
      const thinkingMode = (runConfig.configurable?.thinking as ThinkingMode | undefined) ?? "full";
      // Once the initial plan exists, hide all task-management tools from
      // Nemotron. This makes the one-plan rule structural instead of merely
      // prompt advice, so searches/actions cannot be interrupted by status
      // bookkeeping turns.
      const taskToolNames = new Set(["todo_write", "todo_update", "todo_read", "plan_propose"]);
      const availableTools = currentTodoState === "active" || currentTodoState === "plan_denied"
        ? tools.filter((tool) => !taskToolNames.has(tool.name))
        : tools;
      const baseModel = thinkingMode === "off" ? noThinkingModel : thinkingMode === "low" ? lowThinkingModel : fullThinkingModel;
      const model = availableTools.length ? baseModel.bindTools(availableTools) : baseModel;
      debugLog(`agent start thread=${String(runConfig.configurable?.thread_id ?? "unknown")} thinking=${thinkingMode} messages=${state.messages.length}`);

      // Only the first attempt streams live — runConfig carries the
      // callback manager LangGraph uses to forward per-token chunks to the
      // outer streamMode "messages" consumer. A retry that reused it would
      // stream its own output live right on top of whatever the discarded
      // attempt already sent — duplicate text on screen, verified live: a
      // "Salut !" reply came back from a transient-error retry with the
      // exact same wording (it's a SOUL.md example) and printed twice.
      // Retries run "silent" instead — no live callback forwarding — and
      // whichever attempt is finally accepted becomes the turn's message.
      const silentConfig: RunnableConfig = { ...runConfig, callbacks: undefined };

      let response: AIMessage | undefined;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const invokeConfig = attempt === 1 ? runConfig : silentConfig;
        try {
          response = await model.invoke(messages, invokeConfig);
          debugLog(`model response attempt=${attempt} thread=${String(runConfig.configurable?.thread_id ?? "unknown")} toolCalls=${response.tool_calls?.length ?? 0} content=${JSON.stringify(String(response.content).slice(0, 500))}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          debugLog(`model error attempt=${attempt} thread=${String(runConfig.configurable?.thread_id ?? "unknown")} error=${message}`);
          if (!RETRYABLE_ERROR.test(message) || attempt === MAX_ATTEMPTS || runConfig.signal?.aborted) throw err;
          const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          log("ultron", `transient API error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${message}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (response.tool_calls?.length || !looksLikeFakeToolCall(response.content)) break;

        if (attempt === MAX_ATTEMPTS) break;
        log("ultron", `model wrote a tool call as plain text instead of using it — discarding and retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      }

      // Nemotron sometimes emits a well-formed tool call as text even after
      // retries (any of the three shapes extractFakeToolCall recognizes).
      // Salvage it into a real tool call — turning it into an executed
      // tools-node call and looping back to "agent" — instead of ever
      // discarding a structured request the model clearly intended to make.
      const fakeCall = response ? extractFakeToolCall(response.content) : undefined;
      if (fakeCall) {
        debugLog(`salvaging serialized tool call thread=${String(runConfig.configurable?.thread_id ?? "unknown")} name=${fakeCall.name} args=${JSON.stringify(fakeCall.args)}`);
        response = new AIMessage({ content: "", tool_calls: [{ name: fakeCall.name, args: fakeCall.args, id: `${fakeCall.name}-${Date.now()}` }] });
      }

      // Never surface a fabricated tool call/result as if it were a real
      // answer — after exhausting retries, replace it with an explicit
      // failure notice instead of passing fiction through as fact.
      if (response && !response.tool_calls?.length && looksLikeFakeToolCall(response.content)) {
        log("ultron", `gave up after ${MAX_ATTEMPTS} attempts — the model never issued a real tool call for this turn.`);
        response = new AIMessage(
          "[ultron] Tool call failed to register after several attempts — I'm not going to guess at the answer. Ask again.",
        );
      }

      return { messages: [response as AIMessage] };
    })
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addEdge("tools", "agent");

  return graph.compile({ checkpointer });
}

type CompactionResult = {
  compacted: boolean;
  before: number;
  after: number;
};

function messageText(message: BaseMessage): string {
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  return `${message.getType()}: ${content}`;
}

export async function compactThread(graph: ReturnType<typeof buildGraph>, threadId: string): Promise<CompactionResult> {
  const config = { configurable: { thread_id: threadId } };
  const state = await graph.getState(config);
  const messages = state.values.messages ?? [];
  const before = messages.length;
  if (before < 6) return { compacted: false, before, after: before };

  let keepFrom = Math.max(0, before - 6);
  while (keepFrom > 0 && messages[keepFrom].getType() !== "human") keepFrom--;
  const oldMessages = messages.slice(0, keepFrom);
  const recentMessages = messages.slice(keepFrom);
  if (oldMessages.length < 2) return { compacted: false, before, after: before };

  const summarizer = createNemotronModel("low");
  const summaryResponse = await summarizer.invoke([
    new SystemMessage(
      "Summarize the conversation for future context. Keep concrete facts, decisions, " +
        "unfinished tasks, file paths, errors and user preferences. Omit greetings, " +
        "repetition and hidden reasoning. Return only the concise summary in plain text.",
    ),
    new HumanMessage(oldMessages.map(messageText).join("\n\n")),
  ]);
  const summary = typeof summaryResponse.content === "string" ? summaryResponse.content.trim() : JSON.stringify(summaryResponse.content);
  await graph.updateState(config, {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      new SystemMessage(`[Conversation summary — generated by /compact]\n${summary}`),
      ...recentMessages,
    ],
  });

  return { compacted: true, before, after: recentMessages.length + 1 };
}

export async function prepareRetry(graph: ReturnType<typeof buildGraph>, threadId: string): Promise<string | undefined> {
  const config = { configurable: { thread_id: threadId } };
  const state = await graph.getState(config);
  const messages = state.values.messages ?? [];
  let humanIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].getType() === "human") {
      humanIndex = i;
      break;
    }
  }
  if (humanIndex < 0) return undefined;

  const content = messages[humanIndex].content;
  const lastUserMessage = typeof content === "string" ? content : JSON.stringify(content);
  const removals = messages
    .slice(humanIndex + 1)
    .filter((message: BaseMessage) => message.id)
    .map((message: BaseMessage) => new RemoveMessage({ id: message.id! }));
  if (removals.length) await graph.updateState(config, { messages: removals });
  return lastUserMessage;
}

// Same removal as prepareRetry, plus the trailing human message itself —
// backs the web UI's "edit" action on the last user turn: the caller gets
// the original text back to re-populate the composer with, and the thread
// is left exactly as if that message had never been sent.
export async function prepareEdit(graph: ReturnType<typeof buildGraph>, threadId: string): Promise<string | undefined> {
  const config = { configurable: { thread_id: threadId } };
  const state = await graph.getState(config);
  const messages = state.values.messages ?? [];
  let humanIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].getType() === "human") {
      humanIndex = i;
      break;
    }
  }
  if (humanIndex < 0) return undefined;

  const content = messages[humanIndex].content;
  const lastUserMessage = typeof content === "string" ? content : JSON.stringify(content);
  const removals = messages
    .slice(humanIndex)
    .filter((message: BaseMessage) => message.id)
    .map((message: BaseMessage) => new RemoveMessage({ id: message.id! }));
  if (removals.length) await graph.updateState(config, { messages: removals });
  return lastUserMessage;
}

export interface ChatMessage {
  role: "human" | "ai" | "tool_call" | "tool_result";
  content: string;
  name?: string;
}

export interface SearchMatch {
  chatId: string;
  role: "human" | "ai";
  snippet: string;
  matchIndex: number;
}

const SEARCH_SNIPPET_RADIUS = 60;

// A message-content search, not a SQL query — the checkpointer stores each
// chat's history as an opaque serialized blob per LangGraph's own format
// (see checkpointer.ts), so there's no indexed text column to query
// directly. This reuses listChatMessages per chat instead of adding a
// parallel storage path; fine at personal-project scale (single user,
// dozens of chats, not millions).
export async function searchMessages(
  graph: ReturnType<typeof buildGraph>,
  chatIds: string[],
  query: string,
  limit = 50,
): Promise<Map<string, SearchMatch[]>> {
  const needle = query.trim().toLowerCase();
  const results = new Map<string, SearchMatch[]>();
  if (!needle) return results;

  for (const chatId of chatIds) {
    // Tool calls/results are excluded from search — this indexes what the
    // conversation actually said, not the tool chatter behind it.
    const messages = (await listChatMessages(graph, chatId)).filter(
      (message): message is ChatMessage & { role: "human" | "ai" } => message.role === "human" || message.role === "ai",
    );
    const matches: SearchMatch[] = [];
    for (const message of messages) {
      const lower = message.content.toLowerCase();
      const matchIndex = lower.indexOf(needle);
      if (matchIndex < 0) continue;
      const start = Math.max(0, matchIndex - SEARCH_SNIPPET_RADIUS);
      const end = Math.min(message.content.length, matchIndex + needle.length + SEARCH_SNIPPET_RADIUS);
      const snippet = `${start > 0 ? "…" : ""}${message.content.slice(start, end)}${end < message.content.length ? "…" : ""}`;
      matches.push({ chatId, role: message.role, snippet, matchIndex: matchIndex - start + (start > 0 ? 1 : 0) });
    }
    if (matches.length) results.set(chatId, matches);
    if (results.size >= limit) break;
  }
  return results;
}

// Message list for replaying a chat's history in a UI (the web sidebar
// switching between chats, or reattaching to a spawn_agent execution once
// it's already finished — see runs.ts) — human/ai text plus tool calls and
// their results, in order, so a chat that mostly *did things* (a spawned
// research agent, say) doesn't read as empty. System/summary messages are
// still omitted; they're framing for the model, not part of the visible
// conversation.
export async function listChatMessages(graph: ReturnType<typeof buildGraph>, threadId: string): Promise<ChatMessage[]> {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const messages = (state.values.messages ?? []) as BaseMessage[];
  const out: ChatMessage[] = [];

  for (const message of messages) {
    const type = message.getType();
    if (type === "human" || type === "ai") {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      if (content.trim()) out.push({ role: type, content });
      if (type === "ai") {
        for (const call of (message as AIMessage).tool_calls ?? []) {
          out.push({ role: "tool_call", name: call.name, content: summarizeToolCall(call.name, JSON.stringify(call.args ?? {})) });
        }
      }
    } else if (type === "tool") {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      out.push({ role: "tool_result", name: (message as ToolMessage).name ?? "tool", content });
    }
  }

  return out;
}

function archiveMessageContent(message: BaseMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
}

function archiveTitle(messages: BaseMessage[], requestedTitle?: string): string {
  const requested = requestedTitle?.replace(/\s+/g, " ").trim();
  if (requested) return requested;
  const firstUserMessage = messages.find((message) => message.getType() === "human");
  const content = firstUserMessage ? archiveMessageContent(firstUserMessage).replace(/\s+/g, " ").trim() : "ULTRON conversation";
  return content.length > 48 ? `${content.slice(0, 47).trimEnd()}…` : content;
}

function archiveSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "ultron-conversation";
}

export async function archiveThread(
  graph: ReturnType<typeof buildGraph>,
  threadId: string,
  requestedTitle?: string,
): Promise<{ path: string; title: string }> {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  const messages = (state.values.messages ?? []).filter(
    (message: BaseMessage) => message.getType() === "human" || message.getType() === "ai",
  );
  const archiveDir = join(process.cwd(), "archives");
  mkdirSync(archiveDir, { recursive: true });

  const title = archiveTitle(messages, requestedTitle);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveDir, `${archiveSlug(title)}-${timestamp}.txt`);
  const blocks = messages.map((message: BaseMessage) => {
    const role = message.getType() === "human" ? "USER" : "ULTRON";
    return `===== ${role} =====\n${archiveMessageContent(message)}`;
  });
  const content = [
    "ULTRON CHAT ARCHIVE",
    `Title: ${title}`,
    `Created: ${new Date().toISOString()}`,
    `Thread: ${threadId}`,
    `Messages: ${messages.length}`,
    "",
    ...blocks,
    "",
  ].join("\n");

  writeFileSync(archivePath, content, "utf-8");
  return { path: archivePath, title };
}

export async function resumeThread(
  graph: ReturnType<typeof buildGraph>,
  threadId: string,
  archivePath: string,
): Promise<number> {
  const content = readFileSync(archivePath, "utf-8");
  const blockPattern = /^===== (USER|ULTRON) =====\n([\s\S]*?)(?=\n===== (?:USER|ULTRON) =====\n|\n*$)/gm;
  const messages = [...content.matchAll(blockPattern)].map((match) => {
    const messageContent = match[2].trimEnd();
    return match[1] === "USER" ? new HumanMessage(messageContent) : new AIMessage(messageContent);
  });
  if (messages.length === 0) throw new Error("archive contains no resumable messages");

  await graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...messages] },
  );
  return messages.length;
}
