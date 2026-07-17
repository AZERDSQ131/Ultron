import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// execFile (not exec) — args go straight to the process argv, no shell
// parsing, so an app name or script containing quotes/spaces/metacharacters
// can't break out into shell injection.
export const openApp = tool(
  async ({ name }: { name: string }, config?: RunnableConfig) => {
    try {
      await execFileAsync("open", ["-a", name], { timeout: 10_000, signal: config?.signal });
      return `opened/focused "${name}"`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: could not open "${name}": ${message}`;
    }
  },
  {
    name: "open_app",
    description:
      'Launch or focus a macOS application by name (e.g. "Calculator", "Notes", "Microsoft Outlook") via the ' +
      "system's own app resolution — the reliable way to open or switch to an app. Does not wait for the app to " +
      "finish launching; follow up with applescript_run or a short pause if you need to interact with it right after.",
    schema: z.object({
      name: z.string().describe("Application name, as it appears in the Dock or Applications folder."),
    }),
  },
);

export const runAppleScript = tool(
  async (
    { script, language }: { script: string; language?: "applescript" | "javascript" | null },
    config?: RunnableConfig,
  ) => {
    try {
      const { stdout, stderr } = await execFileAsync(
        "osascript",
        [...(language === "javascript" ? ["-l", "JavaScript"] : []), "-e", script],
        { timeout: 20_000, maxBuffer: 1024 * 1024, signal: config?.signal },
      );
      return (stdout || stderr || "(no output)").trim().slice(0, 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`.slice(0, 4000);
    }
  },
  {
    name: "applescript_run",
    description:
      "Run an AppleScript (or JavaScript for Automation) script and return its output — the reliable way to " +
      "control macOS apps that expose a scripting dictionary (Finder, Notes, Reminders, Calendar, Music, Safari, " +
      "System Events for many system settings, and most native macOS apps). Prefer this over guessing at UI " +
      'clicks: write a script that names what you want, e.g. \'tell application "Notes" to make new note with ' +
      'properties {name:"X", body:"Y"}\', rather than trying to interact with the UI visually. Scripts that use ' +
      "System Events or control other apps' UI require Accessibility/Automation permission granted to ULTRON's " +
      "process in System Settings.",
    schema: z.object({
      script: z.string().describe('The AppleScript (or JavaScript, if language is "javascript") source to run.'),
      language: z.enum(["applescript", "javascript"]).nullable().optional().describe("Defaults to applescript."),
    }),
  },
);
