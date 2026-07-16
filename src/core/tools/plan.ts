import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { config } from "../../config.js";
import { getTodoRegistry, type TodoItem } from "../memory/todos.js";
import { formatTodoList } from "./todos.js";

const todos = getTodoRegistry(config.databasePath);

// Unlike every other tool, plan_propose ALWAYS pauses for human approval,
// regardless of the chat's security mode (see the "call.name === plan_propose"
// special case in toolsNode, graph.ts) — this isn't a safety gate like the
// shell/fs/process tools' "destructive" scope, it's the review step "Plan"
// task mode exists for. Because of that, this function body only ever runs
// once the user has approved: a denial is handled entirely by toolsNode's
// own refusal ToolMessage, which never calls tool.invoke at all. There is
// no "rejected" branch to write here.
export const planPropose = tool(
  async ({ items }: { items: { content: string }[] }, runConfig?: RunnableConfig) => {
    const threadId = runConfig?.configurable?.thread_id;
    if (typeof threadId !== "string") return "error: no active chat to attach this plan to";
    const stored: TodoItem[] = items.map((item) => ({ id: randomUUID(), content: item.content, status: "pending" }));
    todos.set(threadId, stored);
    return `Plan approved by the user — start executing it now (${stored.length} step${stored.length === 1 ? "" : "s"}):\n${formatTodoList(stored)}`;
  },
  {
    name: "plan_propose",
    description:
      "Propose a step-by-step plan and pause for the user's explicit confirmation BEFORE doing any actual work — " +
      "required in 'Plan' task mode as your very first call, before any other tool. The user sees the plan and " +
      "either approves it (in which case you should start executing immediately after) or rejects it. On a " +
      "rejection, do not call plan_propose again right away — respond in plain text instead, ask what they want " +
      "changed or discuss alternatives, and only call plan_propose again once they've given you new direction. " +
      "Once approved, the plan becomes this conversation's to-do list — from then on use `todo_update` for status " +
      "changes, not `todo_write` or another `plan_propose` call.",
    schema: z.object({
      items: z
        .array(z.object({ content: z.string().describe("Short, concrete description of the step.") }))
        .describe("The proposed plan, in order, for the user to review."),
    }),
  },
);
