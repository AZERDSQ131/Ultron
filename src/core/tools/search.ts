import type { RunnableConfig } from "@langchain/core/runnables";

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  score?: number;
};

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, count: number, config?: RunnableConfig): Promise<WebSearchResult[]>;
}

const SEARCH_TIMEOUT_MS = 15_000;
const DUCKDUCKGO_ENDPOINT = "https://html.duckduckgo.com/html/";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const RESULT_LINK_RE = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const RESULT_SNIPPET_RE = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

function timeoutSignal(config?: RunnableConfig): AbortSignal {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return config?.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeDuckDuckGoUrl(raw: string): string {
  const uddgMatch = raw.match(/[?&]uddg=([^&]+)/);
  try {
    const target = uddgMatch ? decodeURIComponent(uddgMatch[1]) : raw;
    return target.startsWith("//") ? `https:${target}` : target;
  } catch {
    return raw;
  }
}

export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly name = "duckduckgo";

  async search(query: string, count: number, config?: RunnableConfig): Promise<WebSearchResult[]> {
    const response = await fetch(`${DUCKDUCKGO_ENDPOINT}?${new URLSearchParams({ q: query })}`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ULTRON/0.1; personal agent)" },
      signal: timeoutSignal(config),
    });
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);

    const html = await response.text();
    const snippets: string[] = [];
    let snippetMatch: RegExpExecArray | null;
    RESULT_SNIPPET_RE.lastIndex = 0;
    while ((snippetMatch = RESULT_SNIPPET_RE.exec(html))) snippets.push(cleanHtml(snippetMatch[1]));

    const results: WebSearchResult[] = [];
    let linkMatch: RegExpExecArray | null;
    RESULT_LINK_RE.lastIndex = 0;
    while ((linkMatch = RESULT_LINK_RE.exec(html)) && results.length < count) {
      const title = cleanHtml(linkMatch[2]);
      if (title) {
        results.push({
          title,
          url: decodeDuckDuckGoUrl(linkMatch[1]),
          snippet: snippets[results.length],
        });
      }
    }
    return results;
  }
}

type TavilyResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
    score?: number;
  }>;
};

export class TavilySearchProvider implements WebSearchProvider {
  readonly name = "tavily";

  constructor(private readonly apiKey: string) {}

  async search(query: string, count: number, config?: RunnableConfig): Promise<WebSearchResult[]> {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: count,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: timeoutSignal(config),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Tavily returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const payload = (await response.json()) as TavilyResponse;
    return (payload.results ?? [])
      .filter((result): result is Required<Pick<typeof result, "title" | "url">> & typeof result => Boolean(result.title && result.url))
      .slice(0, count)
      .map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
        publishedDate: result.published_date,
        score: result.score,
      }));
  }
}

export function createWebSearchProvider(provider: string, tavilyApiKey?: string): WebSearchProvider {
  const selected = provider.toLowerCase();
  if (selected === "tavily" || (selected === "auto" && tavilyApiKey)) {
    if (!tavilyApiKey) throw new Error("WEB_SEARCH_PROVIDER=tavily requires TAVILY_API_KEY");
    return new TavilySearchProvider(tavilyApiKey);
  }
  if (selected !== "auto" && selected !== "duckduckgo") {
    throw new Error(`Unsupported WEB_SEARCH_PROVIDER: ${provider}`);
  }
  return new DuckDuckGoSearchProvider();
}

export function formatSearchResults(provider: string, results: WebSearchResult[]): string {
  if (!results.length) return `(no results from ${provider})`;
  return [`source: ${provider}`, ...results.map((result, index) => {
    const metadata = [result.publishedDate, result.score === undefined ? undefined : `score ${result.score.toFixed(2)}`]
      .filter(Boolean)
      .join(" · ");
    return `${index + 1}. ${result.title}\n   ${result.url}${metadata ? `\n   ${metadata}` : ""}${result.snippet ? `\n   ${result.snippet}` : ""}`;
  })].join("\n\n");
}
