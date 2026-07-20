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
import { skillRead } from "./skills.js";
import { openApp, runAppleScript } from "./macos.js";
import { healthIngest, healthQuery, healthSetProfile, healthReport, healthExport, logMealOrExercise } from "./health.js";

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
  skillRead,
  openApp,
  runAppleScript,
  healthIngest,
  healthQuery,
  healthSetProfile,
  healthReport,
  healthExport,
  logMealOrExercise,
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
  skill_read: "read",
  // Launches a process — a real effect, but bounded to "open this app"
  // with no further reach.
  open_app: "write",
  // Arbitrary AppleScript/JXA can do essentially anything a shell command
  // can (control other apps, System Events, delete files via Finder
  // scripting) — same scope as run_shell_command, not the narrower
  // open_app.
  applescript_run: "destructive",
  // Manual fallback for pasting an export into the conversation — the
  // primary path is the token-authenticated POST /api/health-data/ingest
  // endpoint, called by an external app/shortcut, not this tool.
  health_ingest: "write",
  health_query: "read",
  health_set_profile: "write",
  health_report: "read",
  health_export: "write",
  log_meal_or_exercise: "write",
};
