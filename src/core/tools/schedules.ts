import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { config } from "../../config.js";
import { getChatRegistry } from "../memory/chats.js";
import { AgentRegistry, nextCronDate } from "../memory/agents.js";
import { log } from "../logger.js";

const agents = new AgentRegistry(config.databasePath);
const chats = getChatRegistry(config.databasePath);

export const scheduleTask = tool(
  async ({ name, instruction, cron, delaySeconds, agentName, timezone }: { name: string; instruction: string; cron?: string | null; delaySeconds?: number | null; agentName?: string | null; timezone?: string | null }, runConfig?: RunnableConfig) => {
    try {
      const normalizedAgentName = agentName === "None" || agentName === "null" ? null : agentName;
      const normalizedCron = cron === "None" || cron === "null" ? null : cron;
      log("ultron", `schedule_task invoked name=${name} delaySeconds=${delaySeconds} cron=${normalizedCron ?? "none"}`);
      const threadId = runConfig?.configurable?.thread_id;
      const currentChat = typeof threadId === "string" ? chats.get(threadId) : undefined;
      let agentId = currentChat?.agentId ?? null;
      if (normalizedAgentName?.trim()) {
        const owner = agents.listAgents().find((candidate) => candidate.name.toLowerCase() === normalizedAgentName.trim().toLowerCase());
        if (!owner) return `error: no Agent named "${normalizedAgentName}" exists`;
        agentId = owner.id;
      }
      const next = delaySeconds !== null && delaySeconds !== undefined ? new Date(Date.now() + delaySeconds * 1000) : nextCronDate(normalizedCron ?? "", new Date());
      const created = agents.createSchedule({ agentId, name, instruction, cron: delaySeconds !== null && delaySeconds !== undefined ? "@once" : (normalizedCron ?? ""), timezone: timezone ?? undefined, nextRunAt: next });
      return `Scheduled task "${created.name}" created. It will run at ${next.toISOString()} (${created.timezone})${agentId ? " using its Agent context" : " using ULTRON's global context"}.`;
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "schedule_task",
    description: "Create a persistent scheduled task. Use delaySeconds for a one-time reminder (for example, 60 for 'in one minute'). Use cron for recurring tasks with five fields (minute hour day-of-month month weekday), for example '30 19 * * *'. If the current conversation belongs to an Agent, the task uses that Agent; otherwise pass agentName to assign an existing Agent, or omit it for ULTRON.",
    schema: z.object({
      name: z.string().describe("Short human-readable task name."),
      instruction: z.string().describe("The exact work ULTRON or the Agent must perform when awakened."),
      cron: z.string().nullable().optional().describe("Five-field cron expression for recurring tasks."),
      delaySeconds: z.number().int().positive().nullable().optional().describe("Delay in seconds for a one-time task, e.g. 60 for one minute."),
      agentName: z.string().nullable().optional().describe("Existing Agent name, or null to use the current conversation owner."),
      timezone: z.string().nullable().optional().describe("IANA timezone, defaults to Europe/Paris."),
    }),
  },
);
