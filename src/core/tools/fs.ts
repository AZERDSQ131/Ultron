import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const MAX_READ_CHARS = 20_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".pnpm-store"]);

export const readFile = tool(
  async ({ path }: { path: string }) => {
    try {
      const content = readFileSync(resolve(path), "utf-8");
      if (content.length > MAX_READ_CHARS) {
        return `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated — file is ${content.length} chars, showing first ${MAX_READ_CHARS}]`;
      }
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "read_file",
    description: "Read the full contents of a text file at the given path (absolute or relative to the current working directory).",
    schema: z.object({
      path: z.string().describe("Path to the file to read."),
    }),
  },
);

export const writeFile = tool(
  async ({ path, content }: { path: string; content: string }) => {
    try {
      writeFileSync(resolve(path), content, "utf-8");
      return `wrote ${content.length} bytes to ${path}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "write_file",
    description:
      "Create a file or overwrite it entirely with new content. Use edit_file instead if you only need to change part of an existing file.",
    schema: z.object({
      path: z.string().describe("Path to the file to write."),
      content: z.string().describe("The full content to write to the file."),
    }),
  },
);

export const editFile = tool(
  async ({
    path,
    old_string,
    new_string,
    replace_all,
  }: {
    path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }) => {
    try {
      const resolved = resolve(path);
      const content = readFileSync(resolved, "utf-8");
      const occurrences = content.split(old_string).length - 1;

      if (occurrences === 0) return `error: old_string not found in ${path}`;
      if (occurrences > 1 && !replace_all) {
        return `error: old_string appears ${occurrences} times in ${path} — pass replace_all: true, or include more surrounding context to make it unique`;
      }

      const updated = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
      writeFileSync(resolved, updated, "utf-8");
      return `replaced ${replace_all ? occurrences : 1} occurrence(s) in ${path}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "edit_file",
    description:
      "Replace an exact substring in an existing file with new text. Fails if old_string isn't found, or is ambiguous (matches more than once) unless replace_all is set.",
    schema: z.object({
      path: z.string().describe("Path to the file to edit."),
      old_string: z.string().describe("Exact text to find and replace."),
      new_string: z.string().describe("Text to replace it with."),
      replace_all: z.boolean().nullable().optional().describe("Replace every occurrence instead of requiring exactly one match."),
    }),
  },
);

export const listDirectory = tool(
  async ({ path }: { path?: string }) => {
    try {
      const resolved = resolve(path ?? ".");
      const entries = readdirSync(resolved, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      if (entries.length === 0) return "(empty directory)";
      return entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`).join("\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "list_directory",
    description: "List the immediate contents of a directory (not recursive). Defaults to the current working directory.",
    schema: z.object({
      path: z.string().nullable().optional().describe("Directory to list. Defaults to the current working directory."),
    }),
  },
);

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

const MAX_SEARCH_MATCHES = 100;

export const searchFiles = tool(
  async ({ pattern, path }: { pattern: string; path?: string }) => {
    try {
      const root = resolve(path ?? ".");
      const files: string[] = [];
      walk(root, files);

      const regex = new RegExp(pattern);
      const matches: string[] = [];

      for (const file of files) {
        if (matches.length >= MAX_SEARCH_MATCHES) break;
        let text: string;
        try {
          text = readFileSync(file, "utf-8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${relative(root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      }

      return matches.length ? matches.join("\n") : "(no matches)";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `error: ${message}`;
    }
  },
  {
    name: "search_files",
    description:
      "Search for a regex pattern across text files under a directory, recursively (skips node_modules/.git/dist). Returns matching lines as 'path:line: text', capped at 100 matches.",
    schema: z.object({
      pattern: z.string().describe("Regular expression to search for (JavaScript regex syntax)."),
      path: z.string().nullable().optional().describe("Root directory to search under. Defaults to the current working directory."),
    }),
  },
);
