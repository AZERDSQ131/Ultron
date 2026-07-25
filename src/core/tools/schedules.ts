import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../../config.js";
import { ScheduleRegistry, nextCronDate } from "../memory/schedules.js";
import { log } from "../logger.js";

const schedules = new ScheduleRegistry(config.databasePath);

export const scheduleTask = tool(
  async ({ name, instruction, cron, delaySeconds, timezone }: { name: string; instruction: string; cron?: string | null; delaySeconds?: number | null; timezone?: string | null }) => {
    try {
      const normalizedCron = cron === "None" || cron === "null" ? null : cron;
      log("ultron", `schedule_task invoked name=${name} delaySeconds=${delaySeconds} cron=${normalizedCron ?? "none"}`);
      const next = delaySeconds !== null && delaySeconds !== undefined ? new Date(Date.now() + delaySeconds * 1000) : nextCronDate(normalizedCron ?? "", new Date());
      const created = schedules.createSchedule({ name, instruction, cron: delaySeconds !== null && delaySeconds !== undefined ? "@once" : (normalizedCron ?? ""), timezone: timezone ?? undefined, nextRunAt: next });
      return `Scheduled task "${created.name}" created. It will run at ${next.toISOString()} (${created.timezone}) using ULTRON's global context.`;
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: "schedule_task",
    description: "Create a persistent scheduled task using ULTRON's global context. Use delaySeconds for a one-time reminder (for example, 60 for 'in one minute'). Use cron for recurring tasks with five fields (minute hour day-of-month month weekday), for example '30 19 * * *'.",
    schema: z.object({
      name: z.string().describe("Short human-readable task name."),
      instruction: z.string().describe("The exact work ULTRON or the Agent must perform when awakened."),
      cron: z.string().nullable().optional().describe("Five-field cron expression for recurring tasks."),
      delaySeconds: z.number().int().positive().nullable().optional().describe("Delay in seconds for a one-time task, e.g. 60 for one minute."),
      timezone: z.string().nullable().optional().describe("IANA timezone, defaults to Europe/Paris."),
    }),
  },
);
