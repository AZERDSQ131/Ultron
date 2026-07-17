import { appendFileSync } from "node:fs";
import { join } from "node:path";

const logPath = join(process.cwd(), "ultron-web.log");

// The CLI (interfaces/cli/index.ts) takes over raw-mode terminal control
// and redraws the whole screen from its own `transcript` buffer (see
// drawScreen) — any stray console.error/console.log write outside that
// scheme lands as garbage spliced into the live-rendered UI. That's exactly
// what happened: a diagnostic line ("[graph] agent start thread=...")
// showed up verbatim in the middle of a reply. The CLI disables the console
// echo at startup; the web server has no such constraint (its own terminal
// isn't part of the product surface) and keeps it on by default.
let consoleEchoEnabled = true;

export function disableConsoleEcho(): void {
  consoleEchoEnabled = false;
}

// Shared by graph.ts, server.ts and the tools that log their own
// diagnostics (agents.ts, schedules.ts) so there's one place that knows
// whether stderr is safe to write to right now, instead of each module
// deciding for itself and the CLI having no way to override them all.
export function log(prefix: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${prefix}] ${message}`;
  if (consoleEchoEnabled) console.error(line);
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    /* diagnostics must never break the app */
  }
}
