import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { HumanMessage } from "@langchain/core/messages";
import { getCheckpointer } from "./memory/checkpointer.js";
import { buildGraph, estimateContextUsage } from "./agent/graph.js";
import { config } from "./config.js";
import { tools } from "./tools/index.js";
import { MarkdownStreamRenderer } from "./ui/markdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THREAD_ID = "ultron-main";

const CONTEXT_BAR_WIDTH = 20;

function ruleWidth(): number {
  return Math.min(stdout.columns || 80, 76);
}

function rule(): string {
  return chalk.dim("─".repeat(ruleWidth()));
}

function contextBarColor(ratio: number): (text: string) => string {
  if (ratio < 0.5) return chalk.greenBright;
  if (ratio < 0.8) return chalk.yellowBright;
  return chalk.redBright;
}

function renderContextBar(usedTokens: number, maxTokens: number): string {
  const ratio = Math.min(usedTokens / maxTokens, 1);
  const filled = Math.round(ratio * CONTEXT_BAR_WIDTH);
  const fillColor = contextBarColor(ratio);
  const bar = fillColor("█".repeat(filled)) + chalk.dim("░".repeat(CONTEXT_BAR_WIDTH - filled));
  const pct = Math.round(ratio * 100);
  const maxLabel =
    maxTokens >= 1_000_000
      ? `${maxTokens / 1_000_000}M`
      : maxTokens >= 1000
        ? `${Math.round(maxTokens / 1000)}k`
        : String(maxTokens);
  return `${chalk.dim("context")}  ${bar}  ${usedTokens.toLocaleString()} / ${maxLabel} tokens (${fillColor(`${pct}%`)})`;
}

function printBanner() {
  const art = readFileSync(join(__dirname, "ascii-art.txt"), "utf-8").trimEnd();
  console.log(art);
  console.log();
  console.log(`  ${chalk.dim("model")}    ${config.nemotronModel}`);
  console.log(`  ${chalk.dim("memory")}   connected · thread ${THREAD_ID}`);
  console.log(`  ${chalk.dim("status")}   ${chalk.greenBright("ready")}`);
  console.log();
  console.log(chalk.dim(`  type a message to begin · ctrl+c to stop at any time`));
  console.log();
}

function printHelp() {
  console.log(chalk.dim("  local commands"));
  console.log(`  ${chalk.cyanBright("/help")}     show this help`);
  console.log(`  ${chalk.cyanBright("/status")}   show model, memory and tool status`);
  console.log(`  ${chalk.cyanBright("/clear")}    clear the terminal and redraw the banner`);
  console.log(`  ${chalk.cyanBright("/context")}  show the current context usage`);
  console.log(`  ${chalk.cyanBright("/quit")}     stop ULTRON`);
  console.log();
}

function printStatus() {
  console.log(`  ${chalk.dim("model")}    ${config.nemotronModel}`);
  console.log(`  ${chalk.dim("memory")}   connected · thread ${THREAD_ID}`);
  console.log(`  ${chalk.dim("tools")}    ${tools.length} available`);
  console.log(`  ${chalk.dim("status")}   ${chalk.greenBright("ready")}`);
  console.log();
}

function summarizeToolCall(name: string, rawArgs: string): string {
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
    default:
      return name;
  }
}

async function main() {
  printBanner();

  const checkpointer = await getCheckpointer();
  const graph = buildGraph(checkpointer);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  let abortController: AbortController | undefined;
  let stopping = false;

  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log(chalk.dim("\n[ultron] stopping..."));
    abortController?.abort();
    rl.close();
  });

  try {
    while (!stopping) {
      const currentContextTokens = await estimateContextUsage(graph, THREAD_ID);
      console.log(renderContextBar(currentContextTokens, config.contextWindowTokens));
      const input = await rl.question(`${chalk.cyanBright.bold("you")} ${chalk.dim("›")} `);
      if (stopping) break;
      if (!input.trim()) continue;

      const command = input.trim().toLowerCase();
      if (command.startsWith("/")) {
        switch (command) {
          case "/help":
            printHelp();
            continue;
          case "/status":
            printStatus();
            continue;
          case "/clear":
            stdout.write("\x1b[2J\x1b[H");
            printBanner();
            continue;
          case "/context": {
            const contextTokens = await estimateContextUsage(graph, THREAD_ID);
            console.log(renderContextBar(contextTokens, config.contextWindowTokens));
            console.log();
            continue;
          }
          case "/quit":
            stopping = true;
            continue;
          default:
            console.log(chalk.yellow(`[ultron] unknown command: ${input.trim()} — try /help`));
            continue;
        }
      }

      abortController = new AbortController();
      const turnStarted = Date.now();

      try {
        const stream = await graph.stream(
          { messages: [new HumanMessage(input)] },
          {
            configurable: { thread_id: THREAD_ID },
            signal: abortController.signal,
            streamMode: "messages",
          },
        );

        let wrotePrefix = false;
        let inToolCall = false;
        let generatedChars = 0;
        const pendingToolCalls = new Map<string | number, { name: string; args: string }>();
        const markdown = new MarkdownStreamRenderer();

        for await (const [chunk] of stream) {
          const type = chunk.getType();

          if (type === "tool") {
            if (inToolCall) {
              stdout.write("\n");
              inToolCall = false;
            }
            const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
            const pending = [...pendingToolCalls.values()].find((call) => call.name === toolName);
            if (pending) {
              stdout.write(chalk.dim(`[${summarizeToolCall(pending.name, pending.args)}]\n`));
              const key = [...pendingToolCalls.entries()].find(([, call]) => call === pending)?.[0];
              if (key !== undefined) pendingToolCalls.delete(key);
            }
            stdout.write(chalk.dim(`[tool result · ${toolName}]\n${chunk.content}\n\n`));
            continue;
          }

          if (type !== "ai") continue;

          const toolCallChunks = (
            chunk as unknown as {
              tool_call_chunks?: { name?: string; args?: string; index?: number; id?: string }[];
            }
          ).tool_call_chunks;

          if (toolCallChunks?.length) {
            for (const tc of toolCallChunks) {
              const key = tc.index ?? tc.id ?? tc.name ?? 0;
              const isNewToolCall = !pendingToolCalls.has(key);
              const pending = pendingToolCalls.get(key) ?? { name: tc.name ?? "tool", args: "" };
              pending.name = tc.name ?? pending.name;
              pending.args += tc.args ?? "";
              pendingToolCalls.set(key, pending);
              if (tc.name && isNewToolCall) {
                if (wrotePrefix) {
                  stdout.write("\n\n");
                  wrotePrefix = false;
                }
              }
              if (tc.args) generatedChars += tc.args.length;
            }
            inToolCall = true;
            continue;
          }

          if (typeof chunk.content !== "string" || !chunk.content) continue;

          if (inToolCall) {
            stdout.write("\n\n");
            inToolCall = false;
          }
          if (!wrotePrefix) {
            stdout.write(`${chalk.redBright.bold("ultron")} ${chalk.dim("›")} `);
            wrotePrefix = true;
          }
          stdout.write(markdown.push(chunk.content));
          generatedChars += chunk.content.length;
        }
        stdout.write(markdown.flush());
        stdout.write("\n\n");

        const elapsedSeconds = (Date.now() - turnStarted) / 1000;
        const generatedTokens = Math.max(1, Math.round(generatedChars / 4));
        console.log(chalk.dim(`  ⏱ ${elapsedSeconds.toFixed(1)}s   ≈${generatedTokens.toLocaleString()} tokens`));
        console.log();
      } catch (err) {
        if (abortController.signal.aborted) {
          stdout.write("\n\n");
          break;
        }
        console.error(chalk.red("[ultron] error:"), err);
      }
    }
  } finally {
    rl.close();
    await checkpointer.end?.();
    console.log(chalk.dim("[ultron] stopped."));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red("[ultron] fatal error:"), err);
  process.exit(1);
});
