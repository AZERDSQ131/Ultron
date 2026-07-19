import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { config } from "../../config.js";
import type { HealthDay, HealthRegistry } from "../memory/health.js";

// One-shot dump of the full health history to Markdown — same atomic
// tmp+rename write as src/core/memory/exporter.ts, reused here rather than
// imported since that module's writeExport is chat-shaped (messages, not
// health rows). Not a live/recurring export like chats' — health_report
// (see src/core/tools/health.ts) is the on-demand surface for this; export
// is a separate, explicit action for e.g. taking the data to a doctor.

const EXPORTS_DIR = join(dirname(config.databasePath), "exports");

export function resolveHealthExportPath(path: string): string {
  return isAbsolute(path) ? path : join(EXPORTS_DIR, path);
}

function formatMarkdown(days: HealthDay[]): string {
  const lines = ["# Health history export", "", `_exported ${new Date().toISOString()}, ${days.length} day(s)_`, ""];
  lines.push("| date | steps | active kcal | exercise min | resting HR | walking HR | sleep (h) | HRV (ms) | resp. rate |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const day of days) {
    lines.push(
      `| ${day.date} | ${day.steps ?? ""} | ${day.activeEnergyKcal ?? ""} | ${day.exerciseMinutes ?? ""} | ${day.restingHR ?? ""} | ${day.walkingHR ?? ""} | ${day.sleepDurationSec !== null ? (day.sleepDurationSec / 3600).toFixed(1) : ""} | ${day.hrvAvg ?? ""} | ${day.respiratoryRateAvg ?? ""} |`,
    );
  }
  return lines.join("\n");
}

export async function exportHealthHistory(registry: HealthRegistry, path: string): Promise<string> {
  const resolved = resolveHealthExportPath(path);
  const days = registry.getRange("0000-01-01", "9999-12-31");
  const content = formatMarkdown(days);
  await mkdir(dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp-${process.pid}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, resolved);
  return resolved;
}
