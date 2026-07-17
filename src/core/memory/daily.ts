import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// One append-only Markdown file per day under memory/daily/ (gitignored,
// personal data — same treatment as archives/), for context worth keeping
// around today but not durable enough to earn a spot in MEMORY.md. Only
// today's file is ever read back into the system prompt (see
// buildSystemPrompt in graph.ts) so the prompt doesn't grow without bound;
// older days stay on disk and are reachable with the ordinary file tools.
const dailyDir = join(process.cwd(), "memory", "daily");

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayPath(): string {
  return join(dailyDir, `${todayDate()}.md`);
}

function timeLabel(): string {
  return new Date().toISOString().slice(11, 16);
}

export function appendDailyNote(content: string): string {
  mkdirSync(dailyDir, { recursive: true });
  const path = todayPath();
  const block = `## ${timeLabel()}\n${content.trim()}\n\n`;
  if (!existsSync(path)) appendFileSync(path, `# ${todayDate()}\n\n${block}`, "utf-8");
  else appendFileSync(path, block, "utf-8");
  return block.trim();
}

export function readTodayNote(): string | undefined {
  const path = todayPath();
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8").trim();
}
