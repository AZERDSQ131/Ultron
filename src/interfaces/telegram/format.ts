// Converts the lightweight Markdown ULTRON's replies use (**bold**, *italic*,
// `code`, ```fenced code```, # headers, ~~strikethrough~~, [text](url)) into
// Telegram's HTML parse mode. HTML instead of MarkdownV2: Telegram's
// MarkdownV2 requires escaping a long list of punctuation characters
// anywhere they appear outside formatting, which is exactly the kind of
// thing an LLM's free-form prose trips over (a stray "." or "-" breaks the
// whole message); HTML only needs &/</> escaped, which is mechanical and
// can't be broken by ordinary punctuation.

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Unlikely-to-collide placeholders (no Markdown-significant characters in
// them) so code content can be pulled out, escaped once, and restored after
// every other substitution has run — never re-interpreted as formatting or
// re-escaped.
const codeBlockMarker = (i: number) => `CB${i}`;
const inlineCodeMarker = (i: number) => `IC${i}`;

export function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  let working = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    codeBlocks.push(escapeHtml(code.replace(/\n$/, "")));
    return codeBlockMarker(codeBlocks.length - 1);
  });

  const inlineCode: string[] = [];
  working = working.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCode.push(escapeHtml(code));
    return inlineCodeMarker(inlineCode.length - 1);
  });

  // Escape everything that's left (ordinary prose) before introducing our
  // own <b>/<i>/<a> tags below, so the tags we add are never re-escaped.
  working = escapeHtml(working);

  // Headers — Telegram has no heading concept, bold is the closest.
  working = working.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold before italic, and doubled markers before single ones, so
  // "**bold**" is never partially consumed by the italic pass first.
  working = working.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  working = working.replace(/__([^_]+)__/g, "<b>$1</b>");
  working = working.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
  working = working.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<i>$1</i>");
  working = working.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  working = working.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  working = working.replace(/IC(\d+)/g, (_m, i: string) => `<code>${inlineCode[Number(i)]}</code>`);
  working = working.replace(/CB(\d+)/g, (_m, i: string) => `<pre>${codeBlocks[Number(i)]}</pre>`);

  return working;
}
