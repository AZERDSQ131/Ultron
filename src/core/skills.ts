import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// skills/<name>/SKILL.md, each with a tiny frontmatter (name, description).
// Only the catalog (name + description) is injected into the system prompt
// on every turn — the full body is loaded on demand via the skill_read tool,
// so an unrelated skill doesn't cost context. No YAML dependency: the
// frontmatter is just flat "key: value" lines, a regex is enough.
const skillsDir = join(process.cwd(), "skills");

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
}

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: raw.trim() };
  const [, front, body] = match;
  const meta: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { name: meta.name, description: meta.description, body: body.trim() };
}

export function listSkills(): SkillMeta[] {
  if (!existsSync(skillsDir)) return [];
  const out: SkillMeta[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const { name, description } = parseFrontmatter(readFileSync(skillPath, "utf-8"));
    out.push({ name: name ?? entry.name, description: description ?? "", dir: entry.name });
  }
  return out;
}

export function readSkill(name: string): string | undefined {
  const match = listSkills().find((s) => s.name === name || s.dir === name);
  if (!match) return undefined;
  const { body } = parseFrontmatter(readFileSync(join(skillsDir, match.dir, "SKILL.md"), "utf-8"));
  return body;
}
