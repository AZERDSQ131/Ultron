import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ToolHost = "jetson" | "mac";

// SSH alias for the Mac, resolved on whatever machine ULTRON's process is
// running on (the Jetson in the deployed setup) — expected to already exist
// in that machine's ~/.ssh/config with key auth set up. "jetson" in the
// ToolHost type is just a label for "wherever this process runs", not a
// literal requirement — the same code path works unmodified if ULTRON is
// ever run somewhere else.
const MAC_SSH_ALIAS = process.env.MAC_SSH_HOST ?? "mac";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Runs a shell command locally, or on the Mac via SSH when host is "mac" —
// same execAsync call either way, just prefixed and re-quoted for the
// remote shell. Every fs/shell tool routes through this so "host: mac"
// means the same thing everywhere: run it over there instead of here.
export async function runOnHost(
  host: ToolHost | undefined,
  command: string,
  opts: { timeout?: number; maxBuffer?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  const fullCommand = host === "mac" ? `ssh ${MAC_SSH_ALIAS} ${shellSingleQuote(command)}` : command;
  return execAsync(fullCommand, {
    timeout: opts.timeout ?? 15_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    signal: opts.signal,
  });
}

// Content that needs to survive a shell round-trip intact (file writes,
// AppleScript source) goes through base64 rather than raw shell-quoting —
// arbitrary bytes (newlines, quotes, backticks) are otherwise a real
// injection/corruption risk once the command is itself wrapped in
// `ssh mac '...'` for the remote case.
export function base64Encode(content: string): string {
  return Buffer.from(content, "utf-8").toString("base64");
}

export function base64Upload(path: string, content: string): string {
  return `echo ${shellSingleQuote(base64Encode(content))} | base64 -d > ${shellSingleQuote(path)}`;
}

export function quotePath(path: string): string {
  return shellSingleQuote(path);
}
