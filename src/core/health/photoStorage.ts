import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";

// Meal/exercise photos live on disk, never as SQLite blobs (see
// mealExerciseLog.ts) — one folder per local calendar day next to the
// database file, mirroring how HealthRegistry keeps everything under the
// same root. Only the relative path (kind/date/file.ext) is stored in the
// DB; this module is the only place that knows the absolute root.

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const PHOTOS_ROOT = join(dirname(config.databasePath), "health-photos");

// Returns the path to store in the DB (relative to PHOTOS_ROOT) — callers
// that need to actually read the file back use resolvePhotoPath below.
export function savePhoto(buffer: Buffer, mimeType: string, kind: "meal" | "exercise", date: string): string {
  const ext = EXT_BY_MIME[mimeType] ?? "jpg";
  const relativePath = join(kind, date, `${randomUUID()}.${ext}`);
  const absolutePath = join(PHOTOS_ROOT, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, buffer);
  return relativePath;
}

export function resolvePhotoPath(relativePath: string): string {
  return join(PHOTOS_ROOT, relativePath);
}
