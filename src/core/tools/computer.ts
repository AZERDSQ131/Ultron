// Low-level OS primitives for /computer-use (src/core/computerUse.ts), all
// delegated to a small compiled Swift helper (native/computer-use/main.swift)
// that talks to macOS's Accessibility API (AXUIElement) directly — not
// pixel/screenshot-based. The tree dump gives the model real UI structure
// (role, title, value, frame) to address by path instead of guessing
// coordinates from an image, which is what made the original vision-based
// mechanism unreliable (it typed into whatever window happened to have
// focus, including ULTRON's own terminal, with no way to verify a target
// existed before acting on it).
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
// From src/core/tools/ (or dist/core/tools/ once built) up to the repo root.
const NATIVE_DIR = join(__dirname, "..", "..", "..", "native", "computer-use");
const SOURCE_PATH = join(NATIVE_DIR, "main.swift");
const BINARY_PATH = join(NATIVE_DIR, "bin", "computer-use-helper");

let buildPromise: Promise<void> | undefined;

// Compiled lazily on first use rather than as a pnpm build step — this way
// `pnpm dev` (tsx, no build step) still works, and a source edit is picked
// up automatically without a separate rebuild command.
async function ensureHelperBuilt(): Promise<void> {
  if (buildPromise) return buildPromise;
  buildPromise = (async () => {
    const needsBuild = !existsSync(BINARY_PATH) || statSync(BINARY_PATH).mtimeMs < statSync(SOURCE_PATH).mtimeMs;
    if (!needsBuild) return;
    try {
      await execFileAsync("swiftc", ["-O", SOURCE_PATH, "-o", BINARY_PATH]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to compile computer-use helper (requires Xcode command line tools): ${message}`);
    }
  })();
  return buildPromise;
}

async function runHelper(args: string[], stdin?: string): Promise<unknown> {
  await ensureHelperBuilt();
  return new Promise((resolve, reject) => {
    execFile(BINARY_PATH, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = stdout.trim();
      let parsed: unknown;
      try {
        parsed = output ? JSON.parse(output) : undefined;
      } catch {
        reject(new Error(`computer-use helper returned non-JSON output: ${output || stderr}`));
        return;
      }
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        reject(new Error(String((parsed as { error: unknown }).error)));
        return;
      }
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(parsed);
    }).stdin?.end(stdin ?? "");
  });
}

export interface AXFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AXNode {
  path: number[];
  role: string;
  title?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  frame?: AXFrame;
  children?: AXNode[];
}

export interface FrontmostApp {
  pid: number;
  name: string;
  bundleId?: string;
}

export async function getFrontmostApp(): Promise<FrontmostApp> {
  return (await runHelper(["frontmost"])) as FrontmostApp;
}

const DEFAULT_TREE_DEPTH = 10;

export async function getAccessibilityTree(pid: number, maxDepth = DEFAULT_TREE_DEPTH): Promise<AXNode> {
  return (await runHelper(["tree", String(pid), String(maxDepth)])) as AXNode;
}

export async function openApplication(name: string): Promise<void> {
  await runHelper(["open", name]);
}

export async function clickElement(pid: number, path: number[]): Promise<{ method: string }> {
  return (await runHelper(["click", String(pid), path.join(",")])) as { method: string };
}

export async function scrollElement(
  pid: number,
  path: number[],
  direction: "up" | "down" | "left" | "right",
  amount: number,
): Promise<void> {
  await runHelper(["scroll", String(pid), path.join(","), direction, String(amount)]);
}

// Global — types into whatever currently has keyboard focus, same as a
// physical keyboard would. Pair with clickElement first so the intended
// field/control is actually focused before calling this.
export async function typeText(text: string): Promise<void> {
  await runHelper(["type"], text);
}

export async function pressKeyCombo(combo: string): Promise<void> {
  await runHelper(["key", combo]);
}

const MAX_WAIT_SECONDS = 10;

export async function wait(seconds: number): Promise<void> {
  const clamped = Math.max(0, Math.min(seconds, MAX_WAIT_SECONDS));
  await new Promise((resolve) => setTimeout(resolve, clamped * 1000));
}
