import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { runOnHost, type ToolHost } from "./remoteHost.js";

export const runShellCommand = tool(
  async ({ command, host }: { command: string; host?: ToolHost | null }, config?: RunnableConfig) => {
    try {
      const { stdout, stderr } = await runOnHost(host ?? undefined, command, {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        signal: config?.signal,
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
      "Run a shell command and return its output. By default runs on the machine ULTRON is running on; " +
      "pass host: \"mac\" to run it on the Mac instead (over SSH — requires that machine's SSH access to be " +
      "set up). Use this to inspect the environment (working directory, files, system info) instead of " +
      "guessing or claiming you can't check.",
    schema: z.object({
      command: z.string().describe("The shell command to execute, e.g. 'pwd' or 'ls -la'."),
      host: z.enum(["jetson", "mac"]).nullable().optional().describe(
        "Which machine to run this on. Omit or \"jetson\" for the machine ULTRON itself runs on; \"mac\" to run it on the Mac over SSH.",
      ),
    }),
  },
);
