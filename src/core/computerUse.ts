// /computer-use (CLI-only, src/interfaces/cli/index.ts) — a self-contained
// agent loop that drives the real mouse/keyboard/screen via nut.js
// (src/core/tools/computer.ts), the same pattern goal mode uses
// (src/core/goalJudge.ts): driven entirely on the CLI side rather than
// wired into the main LangGraph graph, because this is a fundamentally
// different loop shape (screenshot in, one tool call out, repeat) that
// doesn't belong sharing the main chat model or its history.
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../config.js";
import { createVisionModel } from "./llm/nemotron.js";
import {
  captureScreenshot,
  click,
  doubleClick,
  dragTo,
  moveMouse,
  pressKeyCombo,
  scaleToScreen,
  scrollAt,
  typeText,
  type Screenshot,
} from "./tools/computer.js";

// A 1x1 transparent PNG — small enough to be a cheap, unambiguous probe:
// any model that accepts it and replies is multimodal-capable on this
// endpoint, and any model that rejects image content clearly isn't.
const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export interface VisionSupportResult {
  supported: boolean;
  reason?: string;
}

const visionSupportCache = new Map<string, VisionSupportResult>();

// Verified live against the NVIDIA endpoint rather than assumed from the
// model id or scraped docs — a served model can change under a fixed id,
// and this is the one check that can't go stale. Cached per model id for
// the life of the process (matches modelContextCache's pattern in the CLI).
export async function verifyVisionSupport(modelId: string): Promise<VisionSupportResult> {
  const cached = visionSupportCache.get(modelId);
  if (cached) return cached;

  const baseUrl = config.nemotronBaseUrl.replace(/\/+$/, "");
  let result: VisionSupportResult;
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.nvidiaApiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 5,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Reply with just the word: ok" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
            ],
          },
        ],
      }),
      // NVIDIA-hosted models can take a while to spin up from cold — 15s
      // was cutting off meta/llama-3.2-90b-vision-instruct mid cold-start
      // and getting misread as "doesn't support images" when it just
      // hadn't answered yet.
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) {
      result = { supported: true };
    } else {
      const body = await response.text().catch(() => "");
      result = { supported: false, reason: `NVIDIA returned HTTP ${response.status}: ${body.slice(0, 300)}` };
    }
  } catch (error) {
    result = { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }

  visionSupportCache.set(modelId, result);
  return result;
}

export interface ComputerUseStep {
  step: number;
  action: string;
  detail: string;
}

export interface ComputerUseResult {
  status: "done" | "failed" | "aborted" | "max_steps";
  summary: string;
  steps: number;
}

export interface ComputerUseOptions {
  instruction: string;
  signal: AbortSignal;
  onStep: (step: ComputerUseStep) => void;
  maxSteps?: number;
}

const SYSTEM_PROMPT = `You are ULTRON's computer-use module, controlling the user's real macOS desktop through tool calls — every action you take (click, type, keypress) really happens on their machine.

You receive a screenshot of the current screen before every decision. Coordinates you give in click/move/drag/scroll tools are in the pixel space of that screenshot image, not the physical screen — they get scaled automatically.

Rules:
- Call exactly one tool per turn. Never respond with plain text instead of a tool call.
- After each action you'll be shown a fresh screenshot — use it to check whether the action worked before deciding the next one, don't assume.
- Prefer keyboard shortcuts (computer_key) over hunting for small UI targets with the mouse when a reliable shortcut exists.
- Call computer_finish as soon as the user's request is satisfied, with a short summary of what you did.
- Call computer_fail if you get stuck, the target isn't on screen, or you need information/permission you don't have — explain why. Do not loop on the same failing action.`;

function buildTools(shotRef: { current: Screenshot }) {
  const point = () => shotRef.current;

  const computerClick = tool(
    async ({ x, y, button }: { x: number; y: number; button?: "left" | "right" | "middle" | null }) => {
      const target = scaleToScreen(point(), x, y);
      await click(target.x, target.y, button ?? "left");
      return `clicked (${button ?? "left"}) at image coords (${x}, ${y}) → screen (${target.x}, ${target.y})`;
    },
    {
      name: "computer_click",
      description: "Click at a point in the current screenshot's coordinate space.",
      schema: z.object({
        x: z.number().describe("X coordinate in the screenshot image."),
        y: z.number().describe("Y coordinate in the screenshot image."),
        button: z.enum(["left", "right", "middle"]).nullable().optional().describe("Mouse button, default left."),
      }),
    },
  );

  const computerDoubleClick = tool(
    async ({ x, y }: { x: number; y: number }) => {
      const target = scaleToScreen(point(), x, y);
      await doubleClick(target.x, target.y);
      return `double-clicked at image coords (${x}, ${y}) → screen (${target.x}, ${target.y})`;
    },
    {
      name: "computer_double_click",
      description: "Double-click at a point in the current screenshot's coordinate space.",
      schema: z.object({
        x: z.number().describe("X coordinate in the screenshot image."),
        y: z.number().describe("Y coordinate in the screenshot image."),
      }),
    },
  );

  const computerMove = tool(
    async ({ x, y }: { x: number; y: number }) => {
      const target = scaleToScreen(point(), x, y);
      await moveMouse(target.x, target.y);
      return `moved cursor to image coords (${x}, ${y}) → screen (${target.x}, ${target.y})`;
    },
    {
      name: "computer_move",
      description: "Move the mouse cursor to a point without clicking.",
      schema: z.object({
        x: z.number().describe("X coordinate in the screenshot image."),
        y: z.number().describe("Y coordinate in the screenshot image."),
      }),
    },
  );

  const computerDrag = tool(
    async ({ fromX, fromY, toX, toY }: { fromX: number; fromY: number; toX: number; toY: number }) => {
      const from = scaleToScreen(point(), fromX, fromY);
      const to = scaleToScreen(point(), toX, toY);
      await dragTo(from.x, from.y, to.x, to.y);
      return `dragged from image (${fromX}, ${fromY}) to (${toX}, ${toY})`;
    },
    {
      name: "computer_drag",
      description: "Press, drag, and release the left mouse button from one point to another.",
      schema: z.object({
        fromX: z.number(),
        fromY: z.number(),
        toX: z.number(),
        toY: z.number(),
      }),
    },
  );

  const computerScroll = tool(
    async ({
      x,
      y,
      direction,
      amount,
    }: {
      x: number;
      y: number;
      direction: "up" | "down" | "left" | "right";
      amount?: number | null;
    }) => {
      const target = scaleToScreen(point(), x, y);
      await scrollAt(target.x, target.y, direction, amount ?? 3);
      return `scrolled ${direction} (${amount ?? 3}) at image coords (${x}, ${y})`;
    },
    {
      name: "computer_scroll",
      description: "Scroll at a point in the current screenshot's coordinate space.",
      schema: z.object({
        x: z.number(),
        y: z.number(),
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().nullable().optional().describe("Scroll steps, default 3."),
      }),
    },
  );

  const computerType = tool(
    async ({ text }: { text: string }) => {
      await typeText(text);
      return `typed: ${text}`;
    },
    {
      name: "computer_type",
      description: "Type a text string via the keyboard, at the current focus/cursor position.",
      schema: z.object({ text: z.string() }),
    },
  );

  const computerKey = tool(
    async ({ combo }: { combo: string }) => {
      await pressKeyCombo(combo);
      return `pressed: ${combo}`;
    },
    {
      name: "computer_key",
      description:
        'Press a key or key combination, e.g. "enter", "escape", "cmd+s", "cmd+shift+4". Modifiers first, joined by "+".',
      schema: z.object({ combo: z.string() }),
    },
  );

  const computerFinish = tool(
    async ({ summary }: { summary: string }) => summary,
    {
      name: "computer_finish",
      description: "Call this once the user's request has been completed, with a short summary of what was done.",
      schema: z.object({ summary: z.string() }),
    },
  );

  const computerFail = tool(
    async ({ reason }: { reason: string }) => reason,
    {
      name: "computer_fail",
      description: "Call this if the task cannot be completed — stuck, target not found, or missing permission/info.",
      schema: z.object({ reason: z.string() }),
    },
  );

  return {
    all: [
      computerClick,
      computerDoubleClick,
      computerMove,
      computerDrag,
      computerScroll,
      computerType,
      computerKey,
      computerFinish,
      computerFail,
    ],
    byName: {
      computer_click: computerClick,
      computer_double_click: computerDoubleClick,
      computer_move: computerMove,
      computer_drag: computerDrag,
      computer_scroll: computerScroll,
      computer_type: computerType,
      computer_key: computerKey,
      computer_finish: computerFinish,
      computer_fail: computerFail,
    } as Record<string, ReturnType<typeof tool>>,
  };
}

interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

// Some vision models on this endpoint (meta/llama-3.2-90b-vision-instruct
// observed doing this) don't reliably use OpenAI-style function calling
// even when tools are bound — they narrate intent and then write the call
// as JSON in the message text instead, e.g. `I will use computer_type...
// {"name": "computer_type", "parameters": {"text": "..."}}`. Same problem
// graph.ts's extractFakeToolCall works around for the main chat model,
// simplified here since this loop's tool set is small and unambiguous.
function extractFakeToolCall(content: unknown): FakeToolCall | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
            .join("\n")
        : "";
  if (!text) return undefined;

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string") return undefined;

  const argsRaw = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? {};
  if (typeof argsRaw !== "object" || argsRaw === null || Array.isArray(argsRaw)) return undefined;
  return { name: obj.name, args: argsRaw as Record<string, unknown> };
}

function screenshotMessage(shot: Screenshot, caption: string): HumanMessage {
  return new HumanMessage({
    content: [
      { type: "text", text: caption },
      { type: "image_url", image_url: { url: `data:image/png;base64,${shot.base64}` } },
    ],
  });
}

export async function runComputerUseLoop(options: ComputerUseOptions): Promise<ComputerUseResult> {
  const { instruction, signal, onStep } = options;
  const maxSteps = options.maxSteps ?? config.computerUseMaxSteps;

  const shotRef = { current: await captureScreenshot() };
  const { all: toolList, byName } = buildTools(shotRef);
  const model = createVisionModel(config.computerUseModel).bindTools(toolList);

  const history: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) return { status: "aborted", summary: "Stopped by user.", steps: step - 1 };

    const caption = step === 1 ? `Task: ${instruction}\n\nCurrent screen:` : "Result of the last action — current screen:";
    const callMessages = [...history, screenshotMessage(shotRef.current, caption)];

    let response: AIMessage;
    try {
      response = await model.invoke(callMessages, { signal });
    } catch (error) {
      if (signal.aborted) return { status: "aborted", summary: "Stopped by user.", steps: step - 1 };
      return {
        status: "failed",
        summary: `Model call failed: ${error instanceof Error ? error.message : String(error)}`,
        steps: step - 1,
      };
    }

    const toolCalls = response.tool_calls ?? [];
    let call: { name: string; args: Record<string, unknown>; id?: string };
    if (toolCalls.length > 0) {
      call = toolCalls[0];
    } else {
      const fake = extractFakeToolCall(response.content);
      if (!fake || (!byName[fake.name] && fake.name !== "computer_finish" && fake.name !== "computer_fail")) {
        const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
        return { status: "failed", summary: text || "Model did not call a tool or produce a summary.", steps: step - 1 };
      }
      call = { name: fake.name, args: fake.args, id: `fake_${step}` };
    }
    history.push(new AIMessage({ content: "", tool_calls: [call] }));

    if (call.name === "computer_finish" || call.name === "computer_fail") {
      const summary = typeof call.args.summary === "string" ? call.args.summary : (call.args.reason as string) ?? "";
      onStep({ step, action: call.name, detail: summary });
      return { status: call.name === "computer_finish" ? "done" : "failed", summary, steps: step };
    }

    const handler = byName[call.name];
    if (!handler) {
      history.push(new ToolMessage({ tool_call_id: call.id ?? "", content: `error: unknown tool "${call.name}"` }));
      onStep({ step, action: call.name, detail: "unknown tool call, skipped" });
      continue;
    }

    let resultText: string;
    try {
      resultText = (await handler.invoke(call.args as never)) as string;
    } catch (error) {
      resultText = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    history.push(new ToolMessage({ tool_call_id: call.id ?? "", content: resultText }));
    onStep({ step, action: call.name, detail: resultText });

    if (signal.aborted) return { status: "aborted", summary: "Stopped by user.", steps: step };

    shotRef.current = await captureScreenshot();
  }

  return { status: "max_steps", summary: `Reached the ${maxSteps}-step limit without finishing.`, steps: maxSteps };
}
