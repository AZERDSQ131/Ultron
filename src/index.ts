import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { HumanMessage } from "@langchain/core/messages";
import { getCheckpointer } from "./memory/checkpointer.js";
import { buildGraph } from "./agent/graph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THREAD_ID = "ultron-main";

function printAsciiArt() {
  const art = readFileSync(join(__dirname, "ascii-art.txt"), "utf-8");
  console.log(art);
}

async function main() {
  printAsciiArt();
  console.log("ULTRON est en ligne. Ctrl+C pour arreter a tout moment.\n");

  const checkpointer = await getCheckpointer();
  const graph = buildGraph(checkpointer);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  let abortController: AbortController | undefined;
  let stopping = false;

  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log("\n[ULTRON] Arret en cours...");
    abortController?.abort();
    rl.close();
  });

  try {
    while (!stopping) {
      const input = await rl.question("Toi > ");
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
        console.log(`\nULTRON > ${last?.content}\n`);
      } catch (err) {
        if (abortController.signal.aborted) break;
        console.error("[ULTRON] Erreur:", err);
      }
    }
  } finally {
    rl.close();
    await checkpointer.end?.();
    console.log("[ULTRON] Arrete.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[ULTRON] Erreur fatale:", err);
  process.exit(1);
});
