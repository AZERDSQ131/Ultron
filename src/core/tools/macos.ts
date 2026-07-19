import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { runOnHost, base64Encode } from "./remoteHost.js";

const execFileAsync = promisify(execFile);

// ULTRON's own process runs on macOS only during local development — in the
// deployed setup (CLAUDE.md's Jetson architecture) it runs on the Jetson, so
// these two tools always need to reach an actual Mac over SSH to do
// anything. Branching on process.platform means the exact same tool call
// works unmodified in both setups instead of needing a host parameter the
// model would have to know to pass.
const localMac = process.platform === "darwin";

export const openApp = tool(
  async ({ name }: { name: string }, config?: RunnableConfig) => {
    try {
      if (localMac) {
        // execFile (not exec) — args go straight to the process argv, no
        // shell parsing, so an app name containing quotes/spaces/
        // metacharacters can't break out into shell injection.
        await execFileAsync("open", ["-a", name], { timeout: 10_000, signal: config?.signal });
      } else {
        await runOnHost("mac", `open -a ${JSON.stringify(name)}`, { timeout: 10_000, signal: config?.signal });
      }
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
      "system's own app resolution — the reliable way to open or switch to an app. Works whether ULTRON runs on " +
      "the Mac itself or remotely (over SSH to the Mac). Does not wait for the app to finish launching; follow up " +
      "with applescript_run or a short pause if you need to interact with it right after.",
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
      let stdout: string;
      let stderr: string;
      if (localMac) {
        ({ stdout, stderr } = await execFileAsync(
          "osascript",
          [...(language === "javascript" ? ["-l", "JavaScript"] : []), "-e", script],
          { timeout: 20_000, maxBuffer: 1024 * 1024, signal: config?.signal },
        ));
      } else {
        // Base64 round-trip avoids every shell-quoting hazard a raw
        // AppleScript source could hit once it's itself wrapped inside
        // `ssh mac '...'` (quotes, backticks, $-expansion, newlines) — write
        // it to a temp file on the Mac, run osascript against that file,
        // clean up either way.
        const flag = language === "javascript" ? "-l JavaScript " : "";
        const command =
          `f=$(mktemp) && echo ${JSON.stringify(base64Encode(script))} | base64 -d > "$f" && ` +
          `osascript ${flag}"$f"; rc=$?; rm -f "$f"; exit $rc`;
        ({ stdout, stderr } = await runOnHost("mac", command, { timeout: 20_000, maxBuffer: 1024 * 1024, signal: config?.signal }));
      }
      return (stdout || stderr || "(no output)").trim().slice(0, 4000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`.slice(0, 4000);
    }
  },
  {
    name: "applescript_run",
    description:
      "Run an AppleScript (or JavaScript for Automation) script on the Mac and return its output — the reliable " +
      "way to control macOS apps that expose a scripting dictionary (Finder, Notes, Reminders, Calendar, Music, " +
      "Safari, System Events for many system settings, and most native macOS apps). Works whether ULTRON runs on " +
      "the Mac itself or remotely (over SSH to the Mac). Prefer this over guessing at UI clicks: write a script " +
      'that names what you want, e.g. \'tell application "Notes" to make new note with properties {name:"X", ' +
      "body:\"Y\"}', rather than trying to interact with the UI visually. Scripts that use System Events or " +
      "control other apps' UI require Accessibility/Automation permission granted on the Mac (to ULTRON's own " +
      "process if running locally, or to sshd/Terminal if running remotely — grant it once from a real session, " +
      "since the permission prompt can't be answered over a headless SSH connection).",
    schema: z.object({
      script: z.string().describe('The AppleScript (or JavaScript, if language is "javascript") source to run.'),
      language: z.enum(["applescript", "javascript"]).nullable().optional().describe("Defaults to applescript."),
    }),
  },
);
