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

const __dirname = dirname(fileURLToPath(import.meta.url));
const THREAD_ID = "ultron-main";

const CONTEXT_BAR_WIDTH = 20;

function ruleWidth(): number {
  return Math.min(stdout.columns || 80, 76);
}

function rule(): string {
  return chalk.dim("─".repeat(ruleWidth()));
}

function renderContextBar(usedTokens: number, maxTokens: number): string {
  const ratio = Math.min(usedTokens / maxTokens, 1);
  const filled = Math.round(ratio * CONTEXT_BAR_WIDTH);
  const bar = chalk.redBright("█".repeat(filled)) + chalk.dim("░".repeat(CONTEXT_BAR_WIDTH - filled));
  const pct = Math.round(ratio * 100);
  const maxLabel =
    maxTokens >= 1_000_000
      ? `${maxTokens / 1_000_000}M`
      : maxTokens >= 1000
        ? `${Math.round(maxTokens / 1000)}k`
        : String(maxTokens);
  return `${chalk.dim("context")}  ${bar}  ${usedTokens.toLocaleString()} / ${maxLabel} tokens (${pct}%)`;
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
      console.log(rule());
      const input = await rl.question(`${chalk.cyanBright.bold("you")} ${chalk.dim("›")} `);
      if (stopping) break;
      if (!input.trim()) continue;

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
        const announcedToolCalls = new Set<string | number>();

        for await (const [chunk] of stream) {
          const type = chunk.getType();

          if (type === "tool") {
            if (inToolCall) {
              stdout.write("\n");
              inToolCall = false;
            }
            const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
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
              if (tc.name && !announcedToolCalls.has(key)) {
                if (wrotePrefix) {
                  stdout.write("\n\n");
                  wrotePrefix = false;
                }
                stdout.write(chalk.dim(`[tool call · ${tc.name}] `));
                announcedToolCalls.add(key);
              }
              if (tc.args) {
                stdout.write(chalk.dim(tc.args));
                generatedChars += tc.args.length;
              }
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
          stdout.write(chunk.content);
          generatedChars += chunk.content.length;
        }
        stdout.write("\n\n");

        const elapsedSeconds = (Date.now() - turnStarted) / 1000;
        const generatedTokens = Math.max(1, Math.round(generatedChars / 4));
        console.log(chalk.dim(`  ⏱ ${elapsedSeconds.toFixed(1)}s   ≈${generatedTokens.toLocaleString()} tokens`));
        console.log(rule());

        const contextTokens = await estimateContextUsage(graph, THREAD_ID);
        console.log(renderContextBar(contextTokens, config.contextWindowTokens));
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
