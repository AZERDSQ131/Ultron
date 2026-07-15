import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

const MAX_BODY_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;

export const fetchUrl = tool(
  async ({ url }: { url: string }, config?: RunnableConfig) => {
    try {
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const signal = config?.signal ? AbortSignal.any([config.signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(url, { signal });
      const text = await res.text();
      const body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated — ${text.length} chars total]` : text;
      return `status: ${res.status}\n\n${body}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "fetch_url",
    description: "Fetch a URL over HTTP(S) and return its raw text content (HTML, JSON, plain text, etc). Use it to read web pages or hit an API.",
    schema: z.object({
      url: z.string().describe("The URL to fetch."),
    }),
  },
);
