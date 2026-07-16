import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { HumanMessage } from "@langchain/core/messages";
import { buildGraph, compactThread, estimateContextUsage, prepareRetry } from "./agent/graph.js";
import { config } from "./config.js";
import type { ThinkingMode } from "./llm/nemotron.js";
import { tools } from "./tools/index.js";
import { MarkdownStreamRenderer } from "./ui/markdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THREAD_ID = "ultron-main";
const CONTEXT_BAR_WIDTH = 20;
const INPUT_PROMPT = `${chalk.cyanBright.bold("you")} ${chalk.dim("›")} `;
const LOCAL_COMMANDS = ["/help", "/status", "/clear", "/context", "/stop", "/retry", "/compact", "/think", "/verbose", "/quit"];

let cancelActiveInput: (() => void) | undefined;
let transcript = "";
let generationInput = "";
let generationCursor = 0;

function appendTranscript(text: string): void {
  transcript += text;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function transcriptRows(text: string): number {
  const width = Math.max(1, stdout.columns || 80);
  return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(stripAnsi(line).length / width)), 0);
}

function commandSuggestion(input: string): string {
  if (!input.startsWith("/") || /\s/.test(input)) return "";
  return LOCAL_COMMANDS.find((command) => command.startsWith(input) && command !== input) ?? "";
}

function renderScreen(input: string, cursor: number, contextLine: string): void {
  const content = transcript.endsWith("\n") ? transcript : `${transcript}\n`;
  const suggestion = commandSuggestion(input);
  const suggestionLine = suggestion ? chalk.dim(`↳ ${suggestion}`) : "";
  const footer = `${rule()}\n${INPUT_PROMPT}${input}\n${suggestionLine}\n${contextLine}\n${rule()}`;
  const rows = stdout.rows || 24;
  const padding = Math.max(0, rows - transcriptRows(content) - 5);

  stdout.write(`\x1b[2J\x1b[H${content}${"\n".repeat(padding)}${footer}`);
  readline.moveCursor(stdout, 0, -3);
  readline.cursorTo(stdout, INPUT_PROMPT.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").length + cursor);
}

function writeLive(text: string, contextLine: string): void {
  if (!text) return;
  appendTranscript(text);
  renderScreen(generationInput, generationCursor, contextLine);
}

function ruleWidth(): number {
  return Math.min(stdout.columns || 80, 76);
}

function rule(): string {
  return chalk.dim("─".repeat(ruleWidth()));
}

function readInput(contextLine: string): Promise<string> {
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);

  return new Promise((resolve) => {
    let value = "";
    let cursor = 0;
    let finished = false;

    const finish = (result: string, keepHistory = true) => {
      if (finished) return;
      finished = true;
      stdin.setRawMode?.(false);
      stdin.removeListener("keypress", onKeypress);
      cancelActiveInput = undefined;

      if (keepHistory && result.trim()) appendTranscript(`${INPUT_PROMPT}${result}\n`);
      renderScreen("", 0, contextLine);
      resolve(result);
    };

    const onKeypress = (input: string, key: readline.Key) => {
      if (key.name === "return" || key.name === "enter") {
        finish(value);
        return;
      }
      if (key.ctrl && key.name === "d") {
        process.emit("SIGINT");
        return;
      }
      if (key.name === "tab") {
        const suggestion = commandSuggestion(value);
        if (suggestion) {
          value = suggestion;
          cursor = value.length;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "backspace") {
        if (cursor > 0) {
          value = value.slice(0, cursor - 1) + value.slice(cursor);
          cursor--;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "delete") {
        if (cursor < value.length) {
          value = value.slice(0, cursor) + value.slice(cursor + 1);
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "left") {
        if (cursor > 0) {
          cursor--;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "right") {
        if (cursor < value.length) {
          cursor++;
          renderScreen(value, cursor, contextLine);
        }
        return;
      }
      if (key.name === "home") {
        cursor = 0;
        renderScreen(value, cursor, contextLine);
        return;
      }
      if (key.name === "end") {
        cursor = value.length;
        renderScreen(value, cursor, contextLine);
        return;
      }
      if (!key.ctrl && !key.meta && input && !input.includes("\n") && !input.includes("\r")) {
        value = value.slice(0, cursor) + input + value.slice(cursor);
        cursor += input.length;
        renderScreen(value, cursor, contextLine);
      }
    };

    cancelActiveInput = () => finish("", false);
    stdin.on("keypress", onKeypress);
    renderScreen(value, cursor, contextLine);
  });
}

function contextBarColor(ratio: number): (text: string) => string {
  if (ratio < 0.5) return chalk.greenBright;
  if (ratio < 0.8) return chalk.yellowBright;
  return chalk.redBright;
}

function renderContextBar(usedTokens: number, maxTokens: number): string {
  const ratio = Math.min(usedTokens / maxTokens, 1);
  const filled = Math.round(ratio * CONTEXT_BAR_WIDTH);
  const fillColor = contextBarColor(ratio);
  const bar = fillColor("█".repeat(filled)) + chalk.dim("░".repeat(CONTEXT_BAR_WIDTH - filled));
  const pct = Math.round(ratio * 100);
  const maxLabel =
    maxTokens >= 1_000_000
      ? `${maxTokens / 1_000_000}M`
      : maxTokens >= 1000
        ? `${Math.round(maxTokens / 1000)}k`
        : String(maxTokens);
  return `${chalk.dim("context")}  ${bar}  ${usedTokens.toLocaleString()} / ${maxLabel} tokens (${fillColor(`${pct}%`)})`;
}

function printBanner() {
  const art = readFileSync(join(__dirname, "ascii-art.txt"), "utf-8").trimEnd();
  appendTranscript(
    `${art}\n\n  ${chalk.dim("model")}    ${config.nemotronModel}\n  ${chalk.dim("memory")}   MEMORY.md\n  ${chalk.dim("status")}   ${chalk.greenBright("ready")}\n\n${chalk.dim("  type a message to begin · ctrl+c to stop at any time")}\n\n`,
  );
  stdout.write(transcript);
}

function printHelp() {
  appendTranscript(
    `${chalk.dim("  local commands")}\n  ${chalk.cyanBright("/help")}     show this help\n  ${chalk.cyanBright("/status")}   show model, memory and tool status\n  ${chalk.cyanBright("/clear")}    clear the terminal and redraw the banner\n  ${chalk.cyanBright("/context")}  show context usage\n  ${chalk.cyanBright("/stop")}     stop the active generation\n  ${chalk.cyanBright("/retry")}    retry the last user message\n  ${chalk.cyanBright("/compact")}  summarize and compact session history\n  ${chalk.cyanBright("/think")}    set reasoning: on, low or off\n  ${chalk.cyanBright("/verbose")}  toggle timing and token metrics\n  ${chalk.cyanBright("/quit")}     stop ULTRON\n\n`,
  );
}

function printStatus(thinkingMode: ThinkingMode, verbose: boolean) {
  appendTranscript(
    `  ${chalk.dim("model")}    ${config.nemotronModel}\n  ${chalk.dim("memory")}   MEMORY.md · thread ${THREAD_ID}\n  ${chalk.dim("tools")}    ${tools.length} available\n  ${chalk.dim("think")}    ${thinkingMode}\n  ${chalk.dim("verbose")}  ${verbose ? "on" : "off"}\n  ${chalk.dim("status")}   ${chalk.greenBright("ready")}\n\n`,
  );
}

function armStopCommand(abort: AbortController, contextLine: string): () => void {
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  const onKeypress = (input: string, key: readline.Key) => {
    if (key.ctrl && key.name === "c") {
      process.emit("SIGINT");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (generationInput.trim().toLowerCase() === "/stop") abort.abort();
      else if (generationInput.trim()) appendTranscript(chalk.yellow("[ultron] only /stop is available while generating.\n"));
      generationInput = "";
      generationCursor = 0;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "backspace") {
      if (generationCursor > 0) {
        generationInput = generationInput.slice(0, generationCursor - 1) + generationInput.slice(generationCursor);
        generationCursor--;
        renderScreen(generationInput, generationCursor, contextLine);
      }
      return;
    }
    if (key.name === "left") {
      if (generationCursor > 0) generationCursor--;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "right") {
      if (generationCursor < generationInput.length) generationCursor++;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "home") {
      generationCursor = 0;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (key.name === "end") {
      generationCursor = generationInput.length;
      renderScreen(generationInput, generationCursor, contextLine);
      return;
    }
    if (!key.ctrl && !key.meta && input && !input.includes("\n") && !input.includes("\r")) {
      generationInput = generationInput.slice(0, generationCursor) + input + generationInput.slice(generationCursor);
      generationCursor += input.length;
      renderScreen(generationInput, generationCursor, contextLine);
    }
  };
  stdin.on("keypress", onKeypress);
  return () => {
    stdin.removeListener("keypress", onKeypress);
    stdin.setRawMode?.(false);
  };
}

function summarizeToolCall(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Streaming arguments may still be incomplete; use the tool name below.
  }

  const path = typeof args.path === "string" ? args.path : undefined;
  switch (name) {
    case "write_file":
      return path && typeof args.content === "string"
        ? `Write ${args.content.length} chars in ${path}`
        : "Write file";
    case "edit_file":
      return path ? `Edit ${path}` : "Edit file";
    case "read_file":
      return path ? `Read ${path}` : "Read file";
    case "list_directory":
      return `List ${path ?? "."}`;
    case "search_files":
      return typeof args.pattern === "string" ? `Search for ${args.pattern}` : "Search files";
    case "fetch_url":
    case "http_request":
      return typeof args.url === "string" ? `Fetch ${args.url}` : "Make HTTP request";
    case "web_search":
      return typeof args.query === "string" ? `Search the web for ${args.query}` : "Search the web";
    case "run_shell_command":
      return typeof args.command === "string" ? `Run ${args.command}` : "Run shell command";
    case "list_processes":
      return "List processes";
    case "kill_process":
      return typeof args.pid === "number" ? `Signal process ${args.pid}` : "Signal process";
    default:
      return name;
  }
}

async function main() {
  printBanner();

  const graph = buildGraph();

  let abortController: AbortController | undefined;
  let stopping = false;
  let thinkingMode: ThinkingMode = "full";
  let verbose = false;

  process.on("SIGINT", () => {
    if (stopping) process.exit(0);
    stopping = true;
    appendTranscript(chalk.dim("\n[ultron] stopping...\n"));
    abortController?.abort();
    cancelActiveInput?.();
  });

  try {
    while (!stopping) {
      const currentContextTokens = await estimateContextUsage(graph, THREAD_ID);
      const contextLine = renderContextBar(currentContextTokens, config.contextWindowTokens);
      let input = await readInput(contextLine);
      if (stopping) break;
      if (!input.trim()) continue;

      const command = input.trim().toLowerCase();
      if (command.startsWith("/")) {
        switch (command) {
          case "/help":
            printHelp();
            continue;
          case "/status":
            printStatus(thinkingMode, verbose);
            continue;
          case "/clear":
            transcript = "";
            printBanner();
            continue;
          case "/context": {
            const contextTokens = await estimateContextUsage(graph, THREAD_ID);
            appendTranscript(`${renderContextBar(contextTokens, config.contextWindowTokens)}\n\n`);
            continue;
          }
          case "/stop":
            appendTranscript(chalk.dim("[ultron] no active generation to stop.\n\n"));
            continue;
          case "/retry": {
            const retryInput = await prepareRetry(graph, THREAD_ID);
            if (!retryInput) {
              appendTranscript(chalk.yellow("[ultron] nothing to retry yet.\n\n"));
              continue;
            }
            input = retryInput;
            break;
          }
          case "/compact": {
            const result = await compactThread(graph, THREAD_ID);
            appendTranscript(
              result.compacted
                ? chalk.dim(`[ultron] compacted ${result.before} messages into ${result.after} context messages.\n\n`)
                : chalk.dim("[ultron] not enough history to compact yet.\n\n"),
            );
            continue;
          }
          case "/think":
            appendTranscript(chalk.dim(`[ultron] reasoning mode: ${thinkingMode} (use /think on|low|off).\n\n`));
            continue;
          case "/verbose":
            appendTranscript(chalk.dim(`[ultron] verbose is ${verbose ? "on" : "off"} (use /verbose on|off).\n\n`));
            continue;
          case "/quit":
            stopping = true;
            continue;
          default:
            if (command.startsWith("/think ")) {
              const mode = command.slice("/think ".length).trim();
              if (mode === "on" || mode === "full") thinkingMode = "full";
              else if (mode === "low") thinkingMode = "low";
              else if (mode === "off") thinkingMode = "off";
              else {
                appendTranscript(chalk.yellow("[ultron] use /think on, /think low or /think off.\n\n"));
                continue;
              }
              appendTranscript(chalk.dim(`[ultron] reasoning mode set to ${thinkingMode}.\n\n`));
              continue;
            }
            if (command === "/verbose on" || command === "/verbose true") {
              verbose = true;
              appendTranscript(chalk.dim("[ultron] verbose on.\n\n"));
              continue;
            }
            if (command === "/verbose off" || command === "/verbose false") {
              verbose = false;
              appendTranscript(chalk.dim("[ultron] verbose off.\n\n"));
              continue;
            }
            appendTranscript(chalk.yellow(`[ultron] unknown command: ${input.trim()} — try /help\n\n`));
            continue;
        }
      }

      abortController = new AbortController();
      const turnStarted = Date.now();
      generationInput = "";
      generationCursor = 0;
      const disarmStopCommand = armStopCommand(abortController, contextLine);

      try {
        const stream = await graph.stream(
          { messages: command === "/retry" ? [] : [new HumanMessage(input)] },
          {
            configurable: { thread_id: THREAD_ID, thinking: thinkingMode },
            signal: abortController.signal,
            streamMode: "messages",
          },
        );

        let wrotePrefix = false;
        let inToolCall = false;
        let generatedChars = 0;
        const pendingToolCalls = new Map<string | number, { name: string; args: string }>();
        const markdown = new MarkdownStreamRenderer();

        for await (const [chunk] of stream) {
          const type = chunk.getType();

          if (type === "tool") {
            if (inToolCall) {
              writeLive("\n", contextLine);
              inToolCall = false;
            }
            const toolName = (chunk as unknown as { name?: string }).name ?? "tool";
            const pending = [...pendingToolCalls.values()].find((call) => call.name === toolName);
            if (pending) {
              writeLive(chalk.dim(`[${summarizeToolCall(pending.name, pending.args)}]\n`), contextLine);
              const key = [...pendingToolCalls.entries()].find(([, call]) => call === pending)?.[0];
              if (key !== undefined) pendingToolCalls.delete(key);
            }
            writeLive(chalk.dim(`[tool result · ${toolName}]\n${chunk.content}\n\n`), contextLine);
            continue;
          }

          if (type !== "ai") continue;

          const toolCallChunks = (
            chunk as unknown as {
              tool_call_chunks?: { name?: string; args?: string; index?: number; id?: string }[];
            }
          ).tool_call_chunks;

          if (toolCallChunks?.length) {
            for (const tc of toolCallChunks) {
              const key = tc.index ?? tc.id ?? tc.name ?? 0;
              const isNewToolCall = !pendingToolCalls.has(key);
              const pending = pendingToolCalls.get(key) ?? { name: tc.name ?? "tool", args: "" };
              pending.name = tc.name ?? pending.name;
              pending.args += tc.args ?? "";
              pendingToolCalls.set(key, pending);
              if (tc.name && isNewToolCall) {
                if (wrotePrefix) {
                  writeLive("\n\n", contextLine);
                  wrotePrefix = false;
                }
              }
              if (tc.args) generatedChars += tc.args.length;
            }
            inToolCall = true;
            continue;
          }

          if (typeof chunk.content !== "string" || !chunk.content) continue;

          if (inToolCall) {
            writeLive("\n\n", contextLine);
            inToolCall = false;
          }
          if (!wrotePrefix) {
            writeLive(`${chalk.redBright.bold("ultron")} ${chalk.dim("›")} `, contextLine);
            wrotePrefix = true;
          }
          writeLive(markdown.push(chunk.content), contextLine);
          generatedChars += chunk.content.length;
        }
        writeLive(markdown.flush(), contextLine);
        appendTranscript("\n\n");

        const elapsedSeconds = (Date.now() - turnStarted) / 1000;
        const generatedTokens = Math.max(1, Math.round(generatedChars / 4));
        if (verbose) appendTranscript(chalk.dim(`  ⏱ ${elapsedSeconds.toFixed(1)}s   ≈${generatedTokens.toLocaleString()} tokens\n\n`));
        renderScreen("", 0, contextLine);
      } catch (err) {
        if (abortController.signal.aborted) {
          appendTranscript("\n\n");
          break;
        }
        appendTranscript(chalk.red(`[ultron] error: ${err instanceof Error ? err.message : String(err)}\n\n`));
      } finally {
        disarmStopCommand();
      }
    }
  } finally {
    cancelActiveInput?.();
    appendTranscript(chalk.dim("[ultron] stopped.\n"));
    stdout.write(chalk.dim("[ultron] stopped.\n"));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red("[ultron] fatal error:"), err);
  process.exit(1);
});
