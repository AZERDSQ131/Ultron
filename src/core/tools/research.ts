import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { config } from "../../config.js";
import { getResearchRegistry, type ResearchNote } from "../memory/research.js";

const research = getResearchRegistry(config.databasePath);

export function formatResearchNotes(notes: ResearchNote[]): string {
  if (!notes.length) return "[ultron] No research notes recorded yet for this conversation.";

  const byAspect = new Map<string, ResearchNote[]>();
  for (const note of notes) {
    const existing = byAspect.get(note.aspect);
    if (existing) existing.push(note);
    else byAspect.set(note.aspect, [note]);
  }

  const sections: string[] = [];
  for (const [aspect, aspectNotes] of byAspect) {
    const lines = aspectNotes.map((note) => {
      const source = note.sourceUrl ? ` [${note.sourceTitle ? `${note.sourceTitle} — ` : ""}${note.sourceUrl}]` : " [no source recorded]";
      const gap = note.gap ? `\n     ↳ still open: ${note.gap}` : "";
      return `  - ${note.finding}${source}${gap}`;
    });
    sections.push(`## ${aspect}\n${lines.join("\n")}`);
  }

  const gaps = notes.filter((note) => note.gap);
  const gapSummary = gaps.length
    ? `\n\nOpen gaps (${gaps.length}) — close the ones that matter for the question before writing the report:\n${gaps
        .map((note) => `  - [${note.aspect}] ${note.gap}`)
        .join("\n")}`
    : "\n\nNo open gaps recorded.";

  const sourceCount = new Set(notes.filter((n) => n.sourceUrl).map((n) => n.sourceUrl)).size;

  return `${notes.length} note${notes.length === 1 ? "" : "s"} across ${byAspect.size} aspect${byAspect.size === 1 ? "" : "s"}, ${sourceCount} distinct source${sourceCount === 1 ? "" : "s"}.\n\n${sections.join("\n\n")}${gapSummary}`;
}

export const researchNote = tool(
  async (
    {
      aspect,
      finding,
      sourceUrl,
      sourceTitle,
      gap,
    }: { aspect: string; finding: string; sourceUrl?: string | null; sourceTitle?: string | null; gap?: string | null },
    runConfig?: RunnableConfig,
  ) => {
    const threadId = runConfig?.configurable?.thread_id;
    if (typeof threadId !== "string") return "error: no active chat to attach this research note to";
    if (!finding.trim()) return "error: finding is empty — record what you actually learned, not a placeholder";

    research.add(threadId, { aspect, finding, sourceUrl, sourceTitle, gap });
    const total = research.count(threadId);
    const openGaps = research.openGaps(threadId).length;
    return `Note ${total} recorded under "${aspect.trim()}".${
      sourceUrl?.trim() ? "" : " No source URL was given — findings without a source can't be cited in the report."
    }${openGaps ? ` ${openGaps} gap${openGaps === 1 ? "" : "s"} still open.` : ""}`;
  },
  {
    name: "research_note",
    description:
      "Record ONE substantive finding during a research run, with the source it came from. Call this as you read " +
      "each source, not in a batch at the end: the pages you fetched get truncated and eventually pushed out of " +
      "context, so an unrecorded finding is a finding you will no longer have when it's time to write the report. " +
      "One call per distinct claim — several claims from the same page means several calls. Set `gap` when a source " +
      "raises a question it doesn't answer; those are what the next round of searches should target.",
    schema: z.object({
      aspect: z
        .string()
        .describe("Which sub-question of the research plan this belongs to. Reuse the exact same wording across notes on the same aspect so they group together."),
      finding: z.string().describe("The specific thing learned, stated concretely enough to cite — include figures, dates and names rather than a vague summary."),
      // .nullable() alongside .optional() for OpenAI's strict function-calling
      // schemas — see the note in todos.ts's todo_update.
      sourceUrl: z.string().nullable().optional().describe("URL this came from. Omit only for a conclusion you derived yourself from other notes."),
      sourceTitle: z.string().nullable().optional().describe("Page or publication title, used to make the report's source list readable."),
      gap: z.string().nullable().optional().describe("What this source left unresolved, if anything — drives the next round of queries."),
    }),
  },
);

export const researchReview = tool(
  async (_input: Record<string, never>, runConfig?: RunnableConfig) => {
    const threadId = runConfig?.configurable?.thread_id;
    if (typeof threadId !== "string") return "error: no active chat to read research notes from";
    return formatResearchNotes(research.list(threadId));
  },
  {
    name: "research_review",
    description:
      "Read back every research note recorded for this conversation, grouped by aspect, with sources and any open " +
      "gaps. Call this once before writing a research report: it returns findings that have since scrolled out of " +
      "context, so the report covers everything actually gathered rather than only what's still visible. Also " +
      "useful mid-run to check which aspects are thin before deciding where to search next.",
    schema: z.object({}),
  },
);
