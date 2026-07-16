import type { StructuredToolInterface } from "@langchain/core/tools";
import { runShellCommand } from "./shell.js";
import { readFile, writeFile, editFile, listDirectory, searchFiles } from "./fs.js";
import { fetchUrl, httpRequest, webSearch } from "./web.js";
import { listProcesses, killProcess } from "./process.js";
import { getCurrentDatetime } from "./datetime.js";

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
};
