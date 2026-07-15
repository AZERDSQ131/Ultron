import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

const execAsync = promisify(exec);

export const listProcesses = tool(
  async (_input: Record<string, never>, config?: RunnableConfig) => {
    try {
      const { stdout } = await execAsync("ps -eo pid,ppid,pcpu,pmem,comm", {
        maxBuffer: 1024 * 1024,
        signal: config?.signal,
      });
      return stdout.trim().slice(0, 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "list_processes",
    description: "List running processes on the machine ULTRON is running on: pid, parent pid, %cpu, %mem, command.",
    schema: z.object({}),
  },
);

export const killProcess = tool(
  async ({ pid, signal }: { pid: number; signal?: string | null }) => {
    try {
      process.kill(pid, (signal ?? "SIGTERM") as NodeJS.Signals);
      return `sent ${signal ?? "SIGTERM"} to pid ${pid}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "kill_process",
    description: "Send a signal to terminate a process by PID. Defaults to SIGTERM; use SIGKILL to force it.",
    schema: z.object({
      pid: z.number().describe("Process ID to signal."),
      signal: z.string().nullable().optional().describe("Signal name, e.g. SIGTERM or SIGKILL. Defaults to SIGTERM."),
    }),
  },
);
