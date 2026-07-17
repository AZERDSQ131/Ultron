import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readSkill } from "../skills.js";

export const skillRead = tool(
  async ({ name }: { name: string }) => {
    const body = readSkill(name);
    if (!body) return `error: no skill named "${name}" — check the <skills> catalog in the system prompt for exact names.`;
    return body;
  },
  {
    name: "skill_read",
    description:
      "Read the full instructions for a skill listed in the <skills> catalog in the system prompt — call it when " +
      "a skill's short description matches the task at hand, before attempting that kind of task from scratch. " +
      "Returns the skill's full Markdown body (steps, conventions, tool-usage notes specific to that task).",
    schema: z.object({
      name: z.string().describe("Exact skill name as shown in the <skills> catalog."),
    }),
  },
);
