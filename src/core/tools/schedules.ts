import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { config } from "../../config.js";
import { getChatRegistry } from "../memory/chats.js";
import { AgentRegistry, nextCronDate } from "../memory/agents.js";

const agents = new AgentRegistry(config.databasePath);
const chats = getChatRegistry(config.databasePath);

export const scheduleTask = tool(
  async ({ name, instruction, cron, agentName, timezone }: { name: string; instruction: string; cron: string; agentName?: string | null; timezone?: string | null }, runConfig?: RunnableConfig) => {
    try {
      const threadId = runConfig?.configurable?.thread_id;
      const currentChat = typeof threadId === "string" ? chats.get(threadId) : undefined;
      let agentId = currentChat?.agentId ?? null;
      if (agentName?.trim()) {
        const owner = agents.listAgents().find((candidate) => candidate.name.toLowerCase() === agentName.trim().toLowerCase());
        if (!owner) return `error: no Agent named "${agentName}" exists`;
        agentId = owner.id;
      }
      const next = nextCronDate(cron, new Date());
      const created = agents.createSchedule({ agentId, name, instruction, cron, timezone: timezone ?? undefined });
      return `Scheduled task "${created.name}" created. It will run at ${next.toISOString()} (${created.timezone})${agentId ? " using its Agent context" : " using ULTRON's global context"}.`;
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "schedule_task",
    description: "Create a persistent scheduled task. Use this when the user asks ULTRON to do something later or repeatedly. Cron uses five fields (minute hour day-of-month month weekday), for example '30 19 * * *'. If the current conversation belongs to an Agent, the task uses that Agent; otherwise pass agentName to assign an existing Agent, or omit it for ULTRON.",
    schema: z.object({
      name: z.string().describe("Short human-readable task name."),
      instruction: z.string().describe("The exact work ULTRON or the Agent must perform when awakened."),
      cron: z.string().describe("Five-field cron expression."),
      agentName: z.string().nullable().optional().describe("Existing Agent name, or null to use the current conversation owner."),
      timezone: z.string().nullable().optional().describe("IANA timezone, defaults to Europe/Paris."),
    }),
  },
);
