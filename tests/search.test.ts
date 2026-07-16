import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWebSearchProvider,
  DuckDuckGoSearchProvider,
  TavilySearchProvider,
  formatSearchResults,
} from "../src/core/tools/search.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("DuckDuckGo provider parses titles, URLs and snippets", async () => {
  globalThis.fetch = async () => new Response(`
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First <b>result</b></a>
    <a class="result__snippet">A useful <b>summary</b>.</a>
    <a class="result__a" href="https://example.com/two">Second result</a>
    <a class="result__snippet">Another summary.</a>
  `, { status: 200 });

  const results = await new DuckDuckGoSearchProvider().search("test", 2);
  assert.deepEqual(results, [
    { title: "First result", url: "https://example.com/one", snippet: "A useful summary." },
    { title: "Second result", url: "https://example.com/two", snippet: "Another summary." },
  ]);
});

test("Tavily provider sends an agent-focused request and normalizes results", async () => {
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ results: [{
      title: "Tavily result",
      url: "https://example.com/tavily",
      content: "Extracted content",
      published_date: "2026-07-16",
      score: 0.91,
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const results = await new TavilySearchProvider("secret").search("current news", 3);
  assert.equal(request?.method, "POST");
  assert.equal(request?.headers.get("authorization"), "Bearer secret");
  assert.deepEqual(await request?.json(), {
    query: "current news",
    search_depth: "basic",
    max_results: 3,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  });
  assert.deepEqual(results, [{
    title: "Tavily result",
    url: "https://example.com/tavily",
    snippet: "Extracted content",
    publishedDate: "2026-07-16",
    score: 0.91,
  }]);
});

test("provider selection uses Tavily only when configured", () => {
  assert.equal(createWebSearchProvider("auto").name, "duckduckgo");
  assert.equal(createWebSearchProvider("auto", "secret").name, "tavily");
  assert.equal(createWebSearchProvider("duckduckgo", "secret").name, "duckduckgo");
  assert.throws(() => createWebSearchProvider("tavily"), /TAVILY_API_KEY/);
  assert.throws(() => createWebSearchProvider("unknown"), /Unsupported/);
});

test("formatted results preserve source metadata for the model", () => {
  const formatted = formatSearchResults("tavily", [{
    title: "A source",
    url: "https://example.com",
    snippet: "A short excerpt",
    publishedDate: "2026-07-16",
    score: 0.8,
  }]);
  assert.match(formatted, /source: tavily/);
  assert.match(formatted, /A source/);
  assert.match(formatted, /2026-07-16 · score 0\.80/);
});
