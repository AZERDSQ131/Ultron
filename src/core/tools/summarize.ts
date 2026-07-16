// Shared between the terminal and web interfaces so tool-call summaries
// stay identical across entry points.
export function summarizeToolCall(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Streaming arguments may still be incomplete; use the tool name below.
  }

  const path = typeof args.path === "string" ? args.path : undefined;
  switch (name) {
    case "write_file":
      return path && typeof args.content === "string"
        ? `Write ${args.content.length} chars in ${path}`
        : "Write file";
    case "edit_file":
      return path ? `Edit ${path}` : "Edit file";
    case "read_file":
      return path ? `Read ${path}` : "Read file";
    case "list_directory":
      return `List ${path ?? "."}`;
    case "search_files":
      return typeof args.pattern === "string" ? `Search for ${args.pattern}` : "Search files";
    case "fetch_url":
    case "http_request":
      return typeof args.url === "string" ? `Fetch ${args.url}` : "Make HTTP request";
    case "web_search":
      return typeof args.query === "string" ? `Search the web for ${args.query}` : "Search the web";
    case "run_shell_command":
      return typeof args.command === "string" ? `Run ${args.command}` : "Run shell command";
    case "list_processes":
      return "List processes";
    case "kill_process":
      return typeof args.pid === "number" ? `Signal process ${args.pid}` : "Signal process";
    case "spawn_agent":
      return typeof args.name === "string" ? `Spawn agent "${args.name}"` : "Spawn agent";
    default:
      return name;
  }
}
