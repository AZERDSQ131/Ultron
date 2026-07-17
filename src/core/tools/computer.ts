// Low-level OS primitives for /computer-use (src/core/computerUse.ts). Kept
// separate from the LangChain tool wrappers so the nut.js/sharp dependency
// surface is isolated to one file — this is the only place in ULTRON that
// touches mouse/keyboard/screen APIs directly.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Button, FileType, Key, keyboard, mouse, screen, straightTo } from "@nut-tree-fork/nut-js";
import sharp from "sharp";

// Anthropic's own computer-use guidance: keep screenshots at or below
// XGA/WXGA-ish resolutions to avoid the API's server-side downscale eating
// the coordinate-mapping precision needed to click accurately. Applied here
// too since DeepSeek V4 Flash's own image-size limits aren't documented —
// this is a safe, well-tested ceiling regardless of provider.
const MAX_SCREENSHOT_EDGE_PX = 1568;

keyboard.config.autoDelayMs = 20;
mouse.config.autoDelayMs = 5;

export interface Screenshot {
  base64: string;
  mediaType: "image/png";
  // Size of the (possibly downscaled) image actually sent to the model —
  // the space its returned coordinates are expressed in.
  imageWidth: number;
  imageHeight: number;
  // Real screen size in the same coordinate space nut.js's mouse API
  // expects — used to scale the model's image-space coordinates back up.
  screenWidth: number;
  screenHeight: number;
}

export async function captureScreenshot(): Promise<Screenshot> {
  const screenWidth = await screen.width();
  const screenHeight = await screen.height();

  const dir = await mkdtemp(join(tmpdir(), "ultron-computer-use-"));
  try {
    const filePath = await screen.capture("shot", FileType.PNG, dir, "", "");
    const longEdge = Math.max(screenWidth, screenHeight);
    const scale = longEdge > MAX_SCREENSHOT_EDGE_PX ? MAX_SCREENSHOT_EDGE_PX / longEdge : 1;
    const imageWidth = Math.round(screenWidth * scale);
    const imageHeight = Math.round(screenHeight * scale);

    const resized = await sharp(filePath)
      .resize(imageWidth, imageHeight, { fit: "fill" })
      .png()
      .toBuffer();

    return {
      base64: resized.toString("base64"),
      mediaType: "image/png",
      imageWidth,
      imageHeight,
      screenWidth,
      screenHeight,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Maps a coordinate in the (downscaled) screenshot's space back to real
// screen coordinates — the inverse of the resize in captureScreenshot.
export function scaleToScreen(shot: Screenshot, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round((x / shot.imageWidth) * shot.screenWidth),
    y: Math.round((y / shot.imageHeight) * shot.screenHeight),
  };
}

async function moveTo(x: number, y: number): Promise<void> {
  await mouse.move(straightTo({ x, y }));
}

export async function moveMouse(x: number, y: number): Promise<void> {
  await moveTo(x, y);
}

const BUTTONS: Record<"left" | "right" | "middle", Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE,
};

export async function click(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
  await moveTo(x, y);
  await mouse.click(BUTTONS[button]);
}

export async function doubleClick(x: number, y: number): Promise<void> {
  await moveTo(x, y);
  await mouse.doubleClick(Button.LEFT);
}

export async function dragTo(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  await moveTo(fromX, fromY);
  await mouse.drag(straightTo({ x: toX, y: toY }));
}

export async function scrollAt(x: number, y: number, direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
  await moveTo(x, y);
  if (direction === "up") await mouse.scrollUp(amount);
  else if (direction === "down") await mouse.scrollDown(amount);
  else if (direction === "left") await mouse.scrollLeft(amount);
  else await mouse.scrollRight(amount);
}

export async function typeText(text: string): Promise<void> {
  await keyboard.type(text);
}

// "cmd+shift+4", "enter", "escape" — lowercase, "+"-joined modifier chain
// ending in the key to press. Modifiers must come first, per nut.js's
// pressKey ordering requirement.
const KEY_ALIASES: Record<string, Key> = {
  cmd: Key.LeftCmd,
  command: Key.LeftCmd,
  super: Key.LeftCmd,
  ctrl: Key.LeftControl,
  control: Key.LeftControl,
  alt: Key.LeftAlt,
  option: Key.LeftAlt,
  shift: Key.LeftShift,
  enter: Key.Return,
  return: Key.Return,
  escape: Key.Escape,
  esc: Key.Escape,
  tab: Key.Tab,
  space: Key.Space,
  backspace: Key.Backspace,
  delete: Key.Delete,
  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  home: Key.Home,
  end: Key.End,
  pageup: Key.PageUp,
  pagedown: Key.PageDown,
};

function resolveKey(token: string): Key {
  const normalized = token.trim().toLowerCase();
  if (normalized in KEY_ALIASES) return KEY_ALIASES[normalized];
  if (normalized.length === 1 && /[a-z]/.test(normalized)) {
    return Key[normalized.toUpperCase() as keyof typeof Key] as unknown as Key;
  }
  if (normalized.length === 1 && /[0-9]/.test(normalized)) {
    return Key[`Num${normalized}` as keyof typeof Key] as unknown as Key;
  }
  if (/^f\d{1,2}$/.test(normalized)) {
    return Key[normalized.toUpperCase() as keyof typeof Key] as unknown as Key;
  }
  throw new Error(`Unrecognized key: "${token}"`);
}

export async function pressKeyCombo(combo: string): Promise<void> {
  const keys = combo.split("+").map(resolveKey);
  await keyboard.pressKey(...keys);
  await keyboard.releaseKey(...keys);
}

