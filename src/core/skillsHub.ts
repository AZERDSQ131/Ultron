import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Search surface for the CLI's "@" picker beyond ULTRON's own skills/ dir.
// skills.sh (the obvious public directory, ~900k skills) requires a Vercel
// OIDC token even for read-only search — not something a project outside
// Vercel can obtain, confirmed by a live 401 against every endpoint. This
// instead reads Anthropic's own public GitHub repo (anthropics/skills),
// small (~17 skills) but real, and needs no auth at all: one Git Trees API
// call (rate-limited, 60/hr unauthenticated — fine, cached an hour) plus
// raw.githubusercontent.com fetches for content (not rate-limited the same
// way, served off GitHub's CDN).
const REPO = "anthropics/skills";
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface HubSkill {
  name: string;
  description: string;
  path: string;
}

let cache: { skills: HubSkill[]; fetchedAt: number } | undefined;
let inflight: Promise<HubSkill[]> | undefined;

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return meta;
}

async function fetchSkillPaths(): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub tree request failed: HTTP ${res.status}`);
  const data = (await res.json()) as { tree?: { path?: string; type?: string }[] };
  return (data.tree ?? [])
    .filter((entry) => entry.type === "blob" && /^skills\/[^/]+\/SKILL\.md$/.test(entry.path ?? ""))
    .map((entry) => entry.path as string);
}

async function fetchRaw(path: string): Promise<string | undefined> {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${path}`);
  return res.ok ? res.text() : undefined;
}

// Cached for an hour and de-duplicated against calls that overlap in
// flight — the CLI's "@" panel calls this on every keystroke while a
// mention is active, so without this it would refire the same network
// round trip on every character typed.
export async function listHubSkills(): Promise<HubSkill[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.skills;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const paths = await fetchSkillPaths();
      const metas = await Promise.all(
        paths.map(async (path) => {
          const raw = await fetchRaw(path);
          if (!raw) return undefined;
          const { name, description } = parseFrontmatter(raw);
          return { name: name ?? path.split("/")[1], description: description ?? "", path } as HubSkill;
        }),
      );
      const skills = metas.filter((s): s is HubSkill => Boolean(s));
      cache = { skills, fetchedAt: Date.now() };
      return skills;
    } catch {
      // Offline or GitHub unreachable — fall back to "no hub results"
      // rather than surfacing an error into the middle of typing; local
      // skills still work. Not cached, so the next "@" press retries.
      return [];
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

// Writes the skill straight into skills/<name>/SKILL.md — the same place
// and format as a hand-written skill, so it's immediately visible to
// listSkills()/skill_read and git-tracked like any other. No separate
// "remote skill" concept to keep in sync elsewhere.
export async function installHubSkill(name: string): Promise<boolean> {
  const skills = await listHubSkills();
  const match = skills.find((s) => s.name === name);
  if (!match) return false;
  const body = await fetchRaw(match.path);
  if (!body) return false;
  const dir = join(process.cwd(), "skills", match.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
  return true;
}
