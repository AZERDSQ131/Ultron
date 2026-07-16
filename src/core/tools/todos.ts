import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { config } from "../../config.js";
import { getTodoRegistry, type TodoItem } from "../memory/todos.js";

const todos = getTodoRegistry(config.databasePath);

function formatList(items: TodoItem[]): string {
  if (!items.length) return "[ultron] To-do list is empty.";
  const marks: Record<TodoItem["status"], string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
  return items.map((item) => `${marks[item.status]} ${item.content}`).join("\n");
}

export const todoWrite = tool(
  async (
    { items }: { items: { content: string; status: "pending" | "in_progress" | "completed" }[] },
    runConfig?: RunnableConfig,
  ) => {
    const threadId = runConfig?.configurable?.thread_id;
    if (typeof threadId !== "string") return "error: no active chat to attach this to-do list to";
    const stored: TodoItem[] = items.map((item) => ({ id: randomUUID(), content: item.content, status: item.status }));
    todos.set(threadId, stored);
    return `To-do list updated (${stored.length} item${stored.length === 1 ? "" : "s"}):\n${formatList(stored)}`;
  },
  {
    name: "todo_write",
    description:
      "Create or replace the current to-do list for this conversation. Use it at the start of a long, multi-step " +
      "task to lay out the plan, and again every time a step's status changes — always pass the full list, not a " +
      "diff. The list renders in the web UI's side panel so the user can follow progress without reading the whole " +
      "transcript. Keep exactly one item 'in_progress' at a time and mark items 'completed' as soon as they're " +
      "actually done, not preemptively.",
    schema: z.object({
      items: z
        .array(
          z.object({
            content: z.string().describe("Short, concrete description of the step."),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .describe("The full to-do list, in order. Replaces whatever list currently exists for this chat."),
    }),
  },
);

export const todoRead = tool(
  async (_input: Record<string, never>, runConfig?: RunnableConfig) => {
    const threadId = runConfig?.configurable?.thread_id;
    if (typeof threadId !== "string") return "error: no active chat to read a to-do list from";
    return formatList(todos.get(threadId));
  },
  {
    name: "todo_read",
    description:
      "Read the current to-do list for this conversation. Use it to check progress before deciding the next step " +
      "on a long task, especially after context has been compacted or a tool call failed.",
    schema: z.object({}),
  },
);
