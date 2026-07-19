#!/usr/bin/env node
// Thin network client: talks to a ULTRON web server (src/interfaces/web/server.ts)
// over HTTP/SSE instead of running buildGraph() in-process — the "ultron"
// command meant to run on the Mac while the actual graph/tools/memory live
// on the Jetson. Deliberately does NOT import ../../config.js or
// ../../core/graph.js: those pull in NVIDIA_API_KEY/DATABASE_PATH validation
// that has no reason to exist on a machine that never touches the model or
// the database directly. The only required input is the server's URL.
import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";

const SERVER_URL = (process.env.ULTRON_SERVER_URL ?? "").replace(/\/+$/, "");
if (!SERVER_URL) {
  console.error(
    "Missing ULTRON_SERVER_URL — set it to the ULTRON web server's address, " +
      "e.g. export ULTRON_SERVER_URL=http://100.114.144.1:4173 (see .env.example).",
  );
  process.exit(1);
}

type ThinkingMode = "full" | "low" | "off";
type TaskMode = "none" | "todo" | "plan" | "goal";
type SecurityMode = "bypass" | "accept_edit" | "manual";

interface Chat {
  id: string;
  title: string;
  updatedAt: string;
  securityMode: SecurityMode;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: unknown;
}

const dim = (text: string) => chalk.dim(text);
const rl = readline.createInterface({ input: stdin, output: stdout });

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function apiPost(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data.error ?? `${path} → HTTP ${res.status}`);
  return data;
}

async function apiPatch(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(data.error ?? `${path} → HTTP ${res.status}`);
  return data;
}

let currentChatId = "";
let currentChatTitle = "";
let currentSecurityMode: SecurityMode = "bypass";
let thinkingMode: ThinkingMode = "full";
let taskMode: TaskMode = "none";
let verbose = false;
let generating = false;
let activeAbort: AbortController | undefined;

async function pickCurrentChat(): Promise<void> {
  const { chats } = await apiGet("/api/chats");
  const chat: Chat | undefined = chats[0];
  if (chat) {
    currentChatId = chat.id;
    currentChatTitle = chat.title;
    currentSecurityMode = chat.securityMode;
  } else {
    const created = await apiPost("/api/chats");
    currentChatId = created.chat.id;
    currentChatTitle = created.chat.title;
    currentSecurityMode = created.chat.securityMode;
  }
}

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const events = buffer.split("\n\n");
  const rest = events.pop() ?? "";
  return { events, rest };
}

// Consumes one SSE response to completion, recursing into /api/approve when
// the stream ends on "approval_required" instead of a terminal event — same
// pattern as the web UI's streamTurn (composer.js), so both clients agree on
// how a turn that pauses mid-way for tool approval keeps rendering as one
// uninterrupted reply.
async function pump(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let wroteAnyText = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseEvents(buffer);
    buffer = rest;

    for (const raw of events) {
      const lines = raw.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      const eventName = eventLine.slice("event: ".length);
      const data = JSON.parse(dataLine.slice("data: ".length));

      if (eventName === "text") {
        stdout.write(data.delta);
        wroteAnyText = true;
      } else if (eventName === "tool_call") {
        if (wroteAnyText) stdout.write("\n");
        wroteAnyText = false;
        stdout.write(dim(`[tool] ${data.name}: ${data.summary}\n`));
      } else if (eventName === "tool_result") {
        const text = String(data.content ?? "");
        stdout.write(dim(`  → ${text.length > 300 ? `${text.slice(0, 300)}…` : text}\n`));
      } else if (eventName === "approval_required") {
        if (wroteAnyText) stdout.write("\n");
        wroteAnyText = false;
        const calls: PendingToolCall[] = data.calls;
        console.log(chalk.yellow(`\n[ultron] approval needed for ${calls.length} tool call(s):`));
        for (const call of calls) console.log(`  · ${call.name} ${dim(JSON.stringify(call.args))}`);
        const answer = (await rl.question(`${chalk.magentaBright.bold("approve all?")} ${dim("(y/N)")} › `)).trim().toLowerCase();
        const approve = answer === "y" || answer === "yes";
        const decisions: Record<string, boolean> = {};
        for (const call of calls) decisions[call.id] = approve;
        await pump(
          await fetch(`${SERVER_URL}/api/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: currentChatId, thinking: thinkingMode, taskMode, decisions }),
            signal: activeAbort?.signal,
          }),
        );
      } else if (eventName === "done") {
        if (wroteAnyText) stdout.write("\n");
        if (verbose) console.log(dim(data.stats));
      } else if (eventName === "goal") {
        console.log(dim(`[ultron] goal ${data.status}${data.reason ? ` — ${data.reason}` : ""}`));
      } else if (eventName === "aborted") {
        if (wroteAnyText) stdout.write("\n");
        console.log(dim("[ultron] generation stopped."));
      } else if (eventName === "error") {
        if (wroteAnyText) stdout.write("\n");
        console.log(chalk.red(`[ultron] error: ${data.message}`));
      }
    }
  }
}

async function sendTurn(body: { text?: string; retry?: boolean }): Promise<void> {
  generating = true;
  activeAbort = new AbortController();
  try {
    const res = await fetch(`${SERVER_URL}/api/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: currentChatId, thinking: thinkingMode, taskMode, ...body }),
      signal: activeAbort.signal,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: "request failed" }))) as { error?: string };
      console.log(chalk.red(`[ultron] ${err.error ?? "request failed"}`));
      return;
    }
    await pump(res);
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) {
      console.log(chalk.red(`[ultron] connection error: ${err instanceof Error ? err.message : String(err)}`));
    }
  } finally {
    generating = false;
    activeAbort = undefined;
  }
}

const HELP_TEXT = `local commands
/help                 show this help
/status               show model, memory and tool status
/context              show current context usage
/stop                 stop the active generation
/retry                remove the previous reply and run the last message again
/compact              summarize and compact session history
/archive [title]      rename (optional), archive this chat, start a new one
/resume               list archived chats — number to reopen, "d<n>" to delete
/think on|low|off     set reasoning mode
/task none|todo|plan|goal   set task mode
/security bypass|accept_edit|manual   set tool approval
/verbose on|off       toggle timing and token metrics
/clear                clear the terminal (local only, history is untouched)
/quit                 exit`;

async function handleCommand(input: string): Promise<void> {
  const [command, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(" ");

  if (command === "/help") { console.log(HELP_TEXT); return; }

  if (command === "/status") {
    const data = await apiGet(`/api/status?chatId=${encodeURIComponent(currentChatId)}`);
    console.log(
      `model: ${data.model}\nchat: ${currentChatTitle}\ntools: ${data.toolCount} available\n` +
        `think: ${thinkingMode}\ntask: ${taskMode}\nverbose: ${verbose ? "on" : "off"}`,
    );
    return;
  }

  if (command === "/context") {
    const data = await apiGet(`/api/status?chatId=${encodeURIComponent(currentChatId)}`);
    const pct = Math.round((data.contextTokens / data.maxTokens) * 100);
    console.log(`context: ${data.contextTokens.toLocaleString()} / ${data.maxTokens.toLocaleString()} tokens (${pct}%)`);
    return;
  }

  if (command === "/stop") {
    if (!generating) { console.log(dim("[ultron] nothing running.")); return; }
    activeAbort?.abort();
    await apiPost("/api/stop", { chatId: currentChatId }).catch(() => {});
    return;
  }

  if (command === "/retry") { await sendTurn({ retry: true }); return; }

  if (command === "/compact") {
    const data = await apiPost("/api/compact", { chatId: currentChatId });
    console.log(
      dim(
        data.compacted
          ? `[ultron] compacted ${data.before} messages into ${data.after} context messages.`
          : "[ultron] not enough history to compact yet.",
      ),
    );
    return;
  }

  if (command === "/archive") {
    let title = arg.trim();
    if (!title) title = (await rl.question(`${chalk.magentaBright.bold("title")} › `)).trim();
    const data = await apiPost(`/api/chats/${encodeURIComponent(currentChatId)}/archive`, title ? { title } : {});
    console.log(chalk.greenBright(`Chat Archived "${data.archived?.title ?? title}"`));
    currentChatId = data.fresh.id;
    currentChatTitle = data.fresh.title;
    currentSecurityMode = data.fresh.securityMode;
    return;
  }

  if (command === "/resume") {
    const { chats } = await apiGet("/api/chats/archived");
    if (!chats.length) { console.log(dim("[ultron] no archived chats.")); return; }
    chats.forEach((c: Chat, i: number) => console.log(`  ${i + 1}. ${c.title}`));
    const answer = (await rl.question(`${chalk.magentaBright.bold("resume")} ${dim("(number, or d<n> to delete)")} › `)).trim();
    const del = /^d(\d+)$/i.exec(answer);
    if (del) {
      const target = chats[Number(del[1]) - 1];
      if (!target) { console.log(chalk.yellow("[ultron] no such entry.")); return; }
      await fetch(`${SERVER_URL}/api/chats/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      console.log(dim(`[ultron] deleted "${target.title}".`));
      return;
    }
    const target = chats[Number(answer) - 1];
    if (!target) { console.log(chalk.yellow("[ultron] no such entry.")); return; }
    await apiPost(`/api/chats/${encodeURIComponent(target.id)}/resume`);
    currentChatId = target.id;
    currentChatTitle = target.title;
    currentSecurityMode = target.securityMode;
    console.log(dim(`[ultron] resumed "${target.title}".`));
    return;
  }

  if (command === "/think") {
    const mode = arg.toLowerCase();
    if (!mode) { console.log(dim(`[ultron] reasoning mode: ${thinkingMode} (use /think on|low|off).`)); return; }
    if (mode === "on" || mode === "full") thinkingMode = "full";
    else if (mode === "low") thinkingMode = "low";
    else if (mode === "off") thinkingMode = "off";
    else { console.log(chalk.yellow("[ultron] use /think on, /think low or /think off.")); return; }
    console.log(dim(`[ultron] reasoning mode set to ${thinkingMode}.`));
    return;
  }

  if (command === "/task") {
    const mode = arg.toLowerCase();
    if (!mode) { console.log(dim(`[ultron] task mode: ${taskMode} (use /task none|todo|plan|goal).`)); return; }
    if (mode !== "none" && mode !== "todo" && mode !== "plan" && mode !== "goal") {
      console.log(chalk.yellow("[ultron] use /task none, /task todo, /task plan or /task goal."));
      return;
    }
    taskMode = mode;
    console.log(dim(`[ultron] task mode set to ${taskMode}.`));
    return;
  }

  if (command === "/security") {
    const mode = arg.toLowerCase();
    if (!mode) {
      console.log(dim(`[ultron] tool approval: ${currentSecurityMode} (use /security bypass|accept_edit|manual).`));
      return;
    }
    if (mode !== "bypass" && mode !== "accept_edit" && mode !== "manual") {
      console.log(chalk.yellow("[ultron] use /security bypass, /security accept_edit or /security manual."));
      return;
    }
    await apiPatch(`/api/chats/${encodeURIComponent(currentChatId)}/security`, { mode });
    currentSecurityMode = mode;
    console.log(dim(`[ultron] tool approval set to ${mode}.`));
    return;
  }

  if (command === "/verbose") {
    const mode = arg.toLowerCase();
    if (mode === "on" || mode === "true") verbose = true;
    else if (mode === "off" || mode === "false") verbose = false;
    else { console.log(dim(`[ultron] verbose is ${verbose ? "on" : "off"} (use /verbose on|off).`)); return; }
    console.log(dim(`[ultron] verbose ${verbose ? "on" : "off"}.`));
    return;
  }

  if (command === "/clear") { console.clear(); return; }

  if (command === "/quit") { rl.close(); process.exit(0); }

  console.log(chalk.yellow(`[ultron] unknown command: ${command} — try /help`));
}

async function main(): Promise<void> {
  try {
    await apiGet("/api/health");
  } catch {
    console.error(chalk.red(`Could not reach ULTRON at ${SERVER_URL} — is the server running there?`));
    process.exit(1);
  }
  await pickCurrentChat();
  console.log(chalk.cyanBright.bold("ULTRON") + dim(` — connected to ${SERVER_URL} · chat "${currentChatTitle}"`));
  console.log(dim("Type your message, or /help for commands.\n"));

  rl.on("SIGINT", () => {
    if (generating) { activeAbort?.abort(); apiPost("/api/stop", { chatId: currentChatId }).catch(() => {}); return; }
    rl.close();
    process.exit(0);
  });

  while (true) {
    const input = (await rl.question(`${chalk.cyanBright.bold("you")} ${dim("›")} `)).trim();
    if (!input) continue;
    if (input.startsWith("/")) {
      await handleCommand(input).catch((err) => console.log(chalk.red(`[ultron] ${err instanceof Error ? err.message : String(err)}`)));
      continue;
    }
    await sendTurn({ text: input });
  }
}

main();
