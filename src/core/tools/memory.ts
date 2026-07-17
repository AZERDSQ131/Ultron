import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { appendDailyNote } from "../memory/daily.js";

export const memoryWrite = tool(
  async ({ content }: { content: string }) => {
    const block = appendDailyNote(content);
    return `Added to today's memory note:\n${block}`;
  },
  {
    name: "memory_write",
    description:
      "Append a short, timestamped note to today's memory log — use it for context worth keeping around for the " +
      "rest of the day (a decision made, something to follow up on, a detail from this conversation) that isn't a " +
      "stable, durable fact. It's append-only: each call adds a new timestamped entry, it never edits or replaces " +
      "previous ones. Only today's note is shown back to you automatically in later turns; for a durable fact or " +
      "preference that should survive across days, edit MEMORY.md directly with edit_file/write_file instead.",
    schema: z.object({
      content: z.string().describe("The note to record, in plain text — concise, no need to restate the date or time."),
    }),
  },
);
