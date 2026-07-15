import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { HumanMessage } from "@langchain/core/messages";
import { getCheckpointer } from "./memory/checkpointer.js";
import { buildGraph } from "./agent/graph.js";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THREAD_ID = "ultron-main";

function printBanner() {
  const art = readFileSync(join(__dirname, "ascii-art.txt"), "utf-8").trimEnd();
  console.log(art);
  console.log();
  console.log(`  model    ${config.nemotronModel}`);
  console.log(`  memory   connected · thread ${THREAD_ID}`);
  console.log(`  status   ready`);
  console.log();
  console.log(`  type a message to begin · ctrl+c to stop at any time`);
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
    console.log("\n[ultron] stopping...");
    abortController?.abort();
    rl.close();
  });

  try {
    while (!stopping) {
      const input = await rl.question("you  ‣ ");
      if (stopping) break;
      if (!input.trim()) continue;

      abortController = new AbortController();
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
        const announcedToolCalls = new Set<string | number>();

        for await (const [chunk] of stream) {
          const type = chunk.getType();

          if (type === "tool") {
            if (inToolCall) {
              stdout.write("\n");
              inToolCall = false;
            }
            const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
            stdout.write(`[tool result · ${toolName}]\n${chunk.content}\n\n`);
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
                stdout.write(`[tool call · ${tc.name}] `);
                announcedToolCalls.add(key);
              }
              if (tc.args) stdout.write(tc.args);
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
            stdout.write("ultron ‣ ");
            wrotePrefix = true;
          }
          stdout.write(chunk.content);
        }
        stdout.write("\n\n");
      } catch (err) {
        if (abortController.signal.aborted) {
          stdout.write("\n\n");
          break;
        }
        console.error("[ultron] error:", err);
      }
    }
  } finally {
    rl.close();
    await checkpointer.end?.();
    console.log("[ultron] stopped.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[ultron] fatal error:", err);
  process.exit(1);
});
