import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { config } from "../config.js";

let checkpointer: PostgresSaver | undefined;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointer) {
    checkpointer = PostgresSaver.fromConnString(config.databaseUrl);
    await checkpointer.setup();
  }
  return checkpointer;
}
