import { randomUUID } from "node:crypto";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { config } from "../../config.js";
import { getTodoRegistry, type TodoItem } from "../memory/todos.js";

const todos = getTodoRegistry(config.databasePath);

// 1-based position in the current list, shown by every tool below, so the
// model can address one item (todo_update) without needing to track the
// internal uuid — "item 2" is something it naturally reasons about, a
// generated id is not.
export function formatTodoList(items: TodoItem[]): string {
  if (!items.length) return "[ultron] To-do list is empty.";
  const marks: Record<TodoItem["status"], string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
  return items.map((item, i) => `${i + 1}. ${marks[item.status]} ${item.content}`).join("\n");
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
    return `To-do list updated (${stored.length} item${stored.length === 1 ? "" : "s"}):\n${formatTodoList(stored)}`;
  },
  {
    name: "todo_write",
    description:
      "Create or replace the ENTIRE current to-do list for this conversation — use it once, at the start of a " +
      "long, multi-step task, to lay out the plan, or later only if the plan itself needs to change (steps added, " +
      "removed, or reordered). For a routine status change on an existing item (starting it, finishing it, " +
      "rewording it), use `todo_update` instead — it changes one item without resending or risking the rest of " +
      "the list. The list renders in the web UI's side panel so the user can follow progress without reading the " +
      "whole transcript. Keep exactly one item 'in_progress' at a time and mark items 'completed' as soon as " +
      "they're actually done, not preemptively.",
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

export const todoUpdate = tool(
  async (
    { index, status, content }: { index: number; status?: "pending" | "in_progress" | "completed"; content?: string },
    runConfig?: RunnableConfig,
  ) => {
    const threadId = runConfig?.configurable?.thread_id;
    if (typeof threadId !== "string") return "error: no active chat to update a to-do list on";
    const items = todos.get(threadId);
    const i = index - 1;
    if (i < 0 || i >= items.length) {
      return `error: no item at index ${index} — the list currently has ${items.length} item${items.length === 1 ? "" : "s"}. Call todo_read to see current positions.`;
    }
    if (status) items[i] = { ...items[i], status };
    if (content?.trim()) items[i] = { ...items[i], content: content.trim() };
    todos.set(threadId, items);
    return `Item ${index} updated:\n${formatTodoList(items)}`;
  },
  {
    name: "todo_update",
    description:
      "Update a single item in the current to-do list by its position (1-based index, as shown by todo_read or " +
      "the last todo_write/todo_update result) — change its status and/or its wording without touching the rest " +
      "of the list. This is the normal way to mark a step 'in_progress' or 'completed' as you work through a " +
      "plan; reach for `todo_write` only when the plan's shape itself needs to change.",
    schema: z.object({
      index: z.number().int().positive().describe("1-based position of the item to update, e.g. 2 for the second item."),
      status: z.enum(["pending", "in_progress", "completed"]).optional().describe("New status for this item, if it changed."),
      content: z.string().optional().describe("New wording for this item, if it needs to change."),
    }),
  },
);

export const todoRead = tool(
  async (_input: Record<string, never>, runConfig?: RunnableConfig) => {
    const threadId = runConfig?.configurable?.thread_id;
    if (typeof threadId !== "string") return "error: no active chat to read a to-do list from";
    return formatTodoList(todos.get(threadId));
  },
  {
    name: "todo_read",
    description:
      "Read the current to-do list for this conversation, with each item's 1-based position — use it to check " +
      "progress and get the index needed for todo_update, especially after context has been compacted or a tool " +
      "call failed partway through.",
    schema: z.object({}),
  },
);
