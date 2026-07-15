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
        const result = await graph.invoke(
          { messages: [new HumanMessage(input)] },
          {
            configurable: { thread_id: THREAD_ID },
            signal: abortController.signal,
          },
        );
        const last = result.messages.at(-1);
        console.log(`ultron ‣ ${last?.content}\n`);
      } catch (err) {
        if (abortController.signal.aborted) break;
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
