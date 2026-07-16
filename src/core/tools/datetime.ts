import { tool } from "@langchain/core/tools";
import { z } from "zod";

// Nemotron has no reliable notion of "now" — without this it hallucinates
// dates when reasoning about deadlines, relative dates ("next Friday"), or
// anything time-sensitive. Returns both an ISO timestamp (unambiguous for
// further computation) and a human-readable local rendering.
export const getCurrentDatetime = tool(
  async ({ timezone }: { timezone?: string | null }) => {
    const now = new Date();
    try {
      const zone = timezone ?? "UTC";
      const formatted = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      return `iso: ${now.toISOString()}\ntimezone: ${zone}\nlocal: ${formatted}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: invalid timezone (${message})\niso: ${now.toISOString()}`;
    }
  },
  {
    name: "get_current_datetime",
    description:
      "Get the current real-world date and time. Use this whenever you need to know today's date, compute a relative date (e.g. 'in 3 days', 'next Friday'), or reason about anything time-sensitive — never guess or rely on training-data knowledge for the current date.",
    schema: z.object({
      timezone: z
        .string()
        .nullable()
        .optional()
        .describe("IANA timezone name, e.g. 'Europe/Paris'. Defaults to UTC."),
    }),
  },
);
