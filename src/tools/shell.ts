import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const execAsync = promisify(exec);

// Scope: write/destructive — runs arbitrary shell commands with the user's
// own permissions. No confirmation gate: the user explicitly asked for a
// full bypass of manual approvals. See CLAUDE.md.
export const runShellCommand = tool(
  async ({ command }: { command: string }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      return (stdout || stderr || "(no output)").trim().slice(0, 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`.slice(0, 4000);
    }
  },
  {
    name: "run_shell_command",
    description:
      "Run a shell command on the machine ULTRON is running on and return its output. " +
      "Use this to inspect the environment (working directory, files, system info) " +
      "instead of guessing or claiming you can't check.",
    schema: z.object({
      command: z.string().describe("The shell command to execute, e.g. 'pwd' or 'ls -la'."),
    }),
  },
);
