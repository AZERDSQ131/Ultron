import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { config as appConfig } from "../../config.js";
import { createWebSearchProvider, formatSearchResults } from "./search.js";

const MAX_BODY_CHARS = 20_000;
const MAX_DOWNLOAD_CHARS = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

function timeoutSignal(config?: RunnableConfig): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return config?.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
}

// Strips HTML down to plain readable text — no dependency, good enough for
// an agent that needs the gist of a page rather than pixel-perfect markup.
// Inspired by OpenClaw's web_fetch, which runs full Readability extraction;
// this is the lightweight version of the same idea.
function extractReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n\n[truncated — ${text.length} chars total]` : text;
}

function validateHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported");
  }
  return url;
}

export const fetchUrl = tool(
  async ({ url }: { url: string }, config?: RunnableConfig) => {
    try {
      const resolvedUrl = validateHttpUrl(url);
      const res = await fetch(resolvedUrl, { signal: timeoutSignal(config) });
      const contentLength = Number(res.headers.get("content-length") ?? 0);
      if (contentLength > MAX_DOWNLOAD_CHARS) {
        return `status: ${res.status}\n\nerror: response is too large (${contentLength} bytes; limit is ${MAX_DOWNLOAD_CHARS})`;
      }
      const text = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      const looksLikeHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(text.slice(0, 200));
      const body = looksLikeHtml ? extractReadableText(text) : text;
      return `status: ${res.status}${res.ok ? "" : " (request failed)"}\nurl: ${res.url || resolvedUrl}\n\n${truncate(body)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "fetch_url",
    description:
      "Fetch a URL with a plain GET and return its readable content — HTML pages are stripped down to plain text, JSON/plain-text responses pass through as-is. For POST/PUT/custom headers, use http_request instead.",
    schema: z.object({
      url: z.string().describe("The URL to fetch."),
    }),
  },
);

export const httpRequest = tool(
  async (
    {
      url,
      method,
      headers,
      body,
    }: { url: string; method?: string | null; headers?: Record<string, string> | null; body?: string | null },
    config?: RunnableConfig,
  ) => {
    try {
      const resolvedMethod = (method ?? "GET").toUpperCase();
      const resolvedUrl = validateHttpUrl(url);
      // Some model outputs pass a placeholder body even for a GET/HEAD
      // call, which the fetch spec (correctly) rejects — drop it instead
      // of surfacing a confusing low-level error for something harmless.
      const allowsBody = resolvedMethod !== "GET" && resolvedMethod !== "HEAD";
      const res = await fetch(resolvedUrl, {
        method: resolvedMethod,
        headers: headers ?? undefined,
        body: allowsBody ? (body ?? undefined) : undefined,
        signal: timeoutSignal(config),
      });
      const text = await res.text();
      const headerLines = Object.fromEntries(res.headers.entries());
      return `status: ${res.status}\nheaders: ${JSON.stringify(headerLines)}\n\n${truncate(text)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "http_request",
    description:
      "Make a raw HTTP request with any method, custom headers, and an optional body — for calling APIs, webhooks, or anything a plain GET (fetch_url) doesn't cover.",
    schema: z.object({
      url: z.string().describe("The URL to request."),
      method: z.string().nullable().optional().describe("HTTP method. Defaults to GET."),
      headers: z.record(z.string()).nullable().optional().describe("Request headers as key/value pairs."),
      body: z.string().nullable().optional().describe("Raw request body, e.g. a JSON string."),
    }),
  },
);

const webSearchProvider = createWebSearchProvider(appConfig.webSearchProvider, appConfig.tavilyApiKey);

export const webSearch = tool(
  async ({ query, count }: { query: string; count?: number | null }, config?: RunnableConfig) => {
    try {
      const n = Math.min(10, Math.max(1, Math.round(count ?? 5)));
      const results = await webSearchProvider.search(query, n, config);
      return formatSearchResults(webSearchProvider.name, results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "web_search",
    description:
      "Search the live web and return ranked results with titles, URLs and readable snippets. Tavily is used when configured; DuckDuckGo is the no-key fallback. Follow up with fetch_url on a promising result to verify the actual source content.",
    schema: z.object({
      query: z.string().describe("The search query."),
      count: z.number().nullable().optional().describe("Number of results to return (1-10). Defaults to 5."),
    }),
  },
);
