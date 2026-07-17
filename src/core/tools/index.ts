import type { StructuredToolInterface } from "@langchain/core/tools";
import { runShellCommand } from "./shell.js";
import { readFile, writeFile, editFile, listDirectory, searchFiles } from "./fs.js";
import { fetchUrl, httpRequest, webSearch } from "./web.js";
import { listProcesses, killProcess } from "./process.js";
import { getCurrentDatetime } from "./datetime.js";
import { scheduleTask } from "./schedules.js";
import { spawnAgent } from "./agents.js";
import { todoWrite, todoUpdate, todoRead } from "./todos.js";
import { planPropose } from "./plan.js";
import { memoryWrite } from "./memory.js";

export type ToolScope = "read" | "write" | "destructive";

export const tools: StructuredToolInterface[] = [
  runShellCommand,
  readFile,
  writeFile,
  editFile,
  listDirectory,
  searchFiles,
  fetchUrl,
  httpRequest,
  webSearch,
  listProcesses,
  killProcess,
  getCurrentDatetime,
  scheduleTask,
  spawnAgent,
  todoWrite,
  todoUpdate,
  todoRead,
  planPropose,
  memoryWrite,
];

// Declared for clarity per CLAUDE.md Phase 3 — confirmation gates are off
// by default (the user's explicit choice), but scope stays visible here.
export const toolScopes: Record<string, ToolScope> = {
  run_shell_command: "destructive",
  read_file: "read",
  write_file: "write",
  edit_file: "write",
  list_directory: "read",
  search_files: "read",
  fetch_url: "read",
  http_request: "write",
  web_search: "read",
  list_processes: "read",
  kill_process: "destructive",
  get_current_datetime: "read",
  schedule_task: "write",
  // Kicks off an autonomous sub-agent run with the same tool access as
  // ULTRON itself (see spawn_agent's MAX_SPAWN_DEPTH guard in agents.ts) —
  // treated the same as shell/kill_process so "accept_edit"/"manual"
  // security modes (see chats.ts) pause it for approval.
  spawn_agent: "destructive",
  todo_write: "write",
  todo_update: "write",
  todo_read: "read",
  // Not "destructive" for approval-mode purposes — it always pauses for
  // confirmation regardless of security mode (see toolsNode's special case
  // in graph.ts), so this scope only affects the badge color shown in the
  // approval card and tool-call blocks.
  plan_propose: "write",
  memory_write: "write",
};
