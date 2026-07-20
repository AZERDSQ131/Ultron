import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

// Files attached via the web composer's "+" button (see
// public/js/composer.js) land on disk next to the database file, one
// folder per chat — the same pattern as health photo storage
// (src/core/health/photoStorage.ts). Deliberately NOT fed into the model
// as inline content: the message just gets the absolute path appended, and
// the model reads it itself with its existing read_file tool (full
// filesystem access is already the project's security posture — see
// CLAUDE.md), so this module only ever needs to write the bytes and hand
// back a path, no new plumbing into graph.ts's message content.

export const UPLOADS_ROOT = join(dirname(config.databasePath), "uploads");

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/[^\w.\- ]/g, "").trim();
  return base.slice(0, 120) || "file";
}

export interface SavedUpload {
  path: string;
  filename: string;
  size: number;
}

export function saveUpload(chatId: string, filename: string, buffer: Buffer): SavedUpload {
  const dir = join(UPLOADS_ROOT, chatId);
  mkdirSync(dir, { recursive: true });
  const safeName = sanitizeFilename(filename);
  const storedName = `${randomUUID().slice(0, 8)}-${safeName}`;
  const filePath = join(dir, storedName);
  writeFileSync(filePath, buffer);
  return { path: filePath, filename: safeName, size: buffer.length };
}
