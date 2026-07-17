// /computer-use (CLI-only, src/interfaces/cli/index.ts) — a self-contained
// agent loop that drives the real macOS UI through the Accessibility API
// (src/core/tools/computer.ts / native/computer-use/main.swift), the same
// pattern goal mode uses (src/core/goalJudge.ts): driven entirely on the
// CLI side rather than wired into the main LangGraph graph, because this is
// a fundamentally different loop shape (read UI tree, one tool call out,
// repeat) that doesn't belong sharing the main chat model or its history.
//
// Deliberately not vision/screenshot-based: an earlier version sent
// screenshots to a vision model and had it click pixel coordinates, which
// in practice typed into whatever window had OS focus (including ULTRON's
// own terminal) with no way to confirm a target actually existed before
// acting on it. Reading the real accessibility tree and addressing
// elements by role/title/path is what macOS apps expose for exactly this
// purpose, and doesn't need a vision-capable model at all — any capable
// text/tool-calling model works.
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../config.js";
import { createComputerUseModel } from "./llm/nemotron.js";
import {
  clickElement,
  getAccessibilityTree,
  getFrontmostApp,
  openApplication,
  pressKeyCombo,
  scrollElement,
  typeText,
  wait,
  type AXNode,
} from "./tools/computer.js";

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

const SYSTEM_PROMPT = `You are ULTRON's computer-use module, controlling the user's real macOS desktop through tool calls — every action you take (opening apps, clicking, typing, keypresses) really happens on their machine.

Before every decision you're shown the accessibility tree of the frontmost application's window: a list of its UI elements with a path, role, title/value/description, and screen frame — not a screenshot. Paths are re-derived fresh from the live UI every step; a path from an earlier step may no longer point at the same element if the screen changed, so always act on the path shown in the MOST RECENT tree.

Rules:
- Call exactly one tool per turn. Never respond with plain text instead of a tool call.
- To open, launch, or switch to an application, ALWAYS call computer_open_app with its name first — this reliably launches or focuses it. Follow it with computer_wait (1-2s) before interacting with it, since it takes a moment to appear and its tree isn't available until it does.
- To interact with an element (button, field, link, checkbox...), use computer_click_element with the exact path shown in the current tree — do not guess or reuse a path from a previous step.
- computer_type sends keystrokes to whatever currently has keyboard focus — click a text field's element first so the text lands in the right place.
- Prefer keyboard shortcuts (computer_key) over hunting for small UI targets when a reliable shortcut exists.
- If the tree looks incomplete or the app hasn't finished loading, use computer_wait and check again rather than acting blind.
- Call computer_finish as soon as the user's request is satisfied, with a short summary of what you did.
- Call computer_fail if you get stuck, the target isn't in the tree, or you need information/permission you don't have — explain why. Do not loop on the same failing action.`;

interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

// Some models on this endpoint don't reliably use OpenAI-style function
// calling even with tools bound and tool_choice: "required" — they narrate
// intent and then write the call as JSON in the message text instead, e.g.
// `I will use computer_type... {"name": "computer_type", "parameters":
// {"text": "..."}}`. Same problem graph.ts's extractFakeToolCall works
// around for the main chat model, simplified here since this loop's tool
// set is small and unambiguous.
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

const MAX_TREE_LINES = 300;

// Renders the pruned AX tree as compact indented text instead of raw JSON —
// noticeably fewer tokens, and easier for the model to scan for a role/title
// than nested braces.
function renderTree(node: AXNode, lines: string[]): void {
  if (lines.length >= MAX_TREE_LINES) return;
  const attrs: string[] = [];
  if (node.title) attrs.push(`title="${node.title}"`);
  if (node.value) attrs.push(`value="${node.value.length > 80 ? node.value.slice(0, 80) + "…" : node.value}"`);
  if (node.description) attrs.push(`desc="${node.description}"`);
  if (node.enabled === false) attrs.push("disabled");
  if (node.frame) attrs.push(`frame=(${Math.round(node.frame.x)},${Math.round(node.frame.y)} ${Math.round(node.frame.width)}x${Math.round(node.frame.height)})`);
  const indent = "  ".repeat(node.path.length);
  lines.push(`${indent}[${node.path.join(".")}] ${node.role} ${attrs.join(" ")}`.trimEnd());
  for (const child of node.children ?? []) {
    if (lines.length >= MAX_TREE_LINES) {
      lines.push(`${indent}  … truncated (tree too large)`);
      return;
    }
    renderTree(child, lines);
  }
}

async function describeCurrentScreen(): Promise<{ pid: number; appName: string; treeText: string }> {
  const app = await getFrontmostApp();
  try {
    const tree = await getAccessibilityTree(app.pid);
    const lines: string[] = [];
    renderTree(tree, lines);
    return { pid: app.pid, appName: app.name, treeText: lines.join("\n") };
  } catch (error) {
    return {
      pid: app.pid,
      appName: app.name,
      treeText: `(could not read UI tree: ${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function buildTools(pidRef: { current: number }) {
  const computerClickElement = tool(
    async ({ path }: { path: number[] }) => {
      const result = await clickElement(pidRef.current, path);
      return `clicked element at path [${path.join(",")}] (${result.method})`;
    },
    {
      name: "computer_click_element",
      description: "Click a UI element by its path, exactly as shown in the current accessibility tree.",
      schema: z.object({
        path: z.array(z.number().int().nonnegative()).describe("Element path, e.g. [1, 0, 3] for the tree line \"[1.0.3]\"."),
      }),
    },
  );

  const computerScrollElement = tool(
    async ({
      path,
      direction,
      amount,
    }: {
      path: number[];
      direction: "up" | "down" | "left" | "right";
      amount?: number | null;
    }) => {
      await scrollElement(pidRef.current, path, direction, amount ?? 3);
      return `scrolled ${direction} (${amount ?? 3}) at element path [${path.join(",")}]`;
    },
    {
      name: "computer_scroll_element",
      description: "Scroll at a UI element's location by its path from the current accessibility tree.",
      schema: z.object({
        path: z.array(z.number().int().nonnegative()),
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
      description: "Type a text string via the keyboard, at the current focus/cursor position. Click a field first.",
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

  const computerOpenApp = tool(
    async ({ name }: { name: string }) => {
      await openApplication(name);
      return `opened/focused application: ${name}`;
    },
    {
      name: "computer_open_app",
      description: "Launch or focus a macOS application by name — the reliable way to open/switch to an app.",
      schema: z.object({ name: z.string() }),
    },
  );

  const computerWait = tool(
    async ({ seconds }: { seconds: number }) => {
      await wait(seconds);
      return `waited ${seconds}s`;
    },
    {
      name: "computer_wait",
      description: "Pause briefly (max 10s) — use after opening an app or triggering something slow to load.",
      schema: z.object({ seconds: z.number().min(0).max(10) }),
    },
  );

  const computerFinish = tool(async ({ summary }: { summary: string }) => summary, {
    name: "computer_finish",
    description: "Call this once the user's request has been completed, with a short summary of what was done.",
    schema: z.object({ summary: z.string() }),
  });

  const computerFail = tool(async ({ reason }: { reason: string }) => reason, {
    name: "computer_fail",
    description: "Call this if the task cannot be completed — stuck, target not found, or missing permission/info.",
    schema: z.object({ reason: z.string() }),
  });

  return {
    all: [
      computerClickElement,
      computerScrollElement,
      computerType,
      computerKey,
      computerOpenApp,
      computerWait,
      computerFinish,
      computerFail,
    ],
    byName: {
      computer_click_element: computerClickElement,
      computer_scroll_element: computerScrollElement,
      computer_type: computerType,
      computer_key: computerKey,
      computer_open_app: computerOpenApp,
      computer_wait: computerWait,
      computer_finish: computerFinish,
      computer_fail: computerFail,
    } as Record<string, ReturnType<typeof tool>>,
  };
}

function treeMessage(appName: string, treeText: string, caption: string): HumanMessage {
  return new HumanMessage(`${caption}\n\nFrontmost app: ${appName}\n\nAccessibility tree:\n${treeText || "(empty)"}`);
}

export async function runComputerUseLoop(options: ComputerUseOptions): Promise<ComputerUseResult> {
  const { instruction, signal, onStep } = options;
  const maxSteps = options.maxSteps ?? config.computerUseMaxSteps;

  const initial = await describeCurrentScreen();
  const pidRef = { current: initial.pid };
  const { all: toolList, byName } = buildTools(pidRef);
  // tool_choice: "required" pushes the API to actually use OpenAI-style
  // function calling instead of narrating intent as plain text.
  const model = createComputerUseModel(config.computerUseModel).bindTools(toolList, { tool_choice: "required" });

  const history: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];
  const MAX_TOOL_CALL_RETRIES = 2;
  let current = initial;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) return { status: "aborted", summary: "Stopped by user.", steps: step - 1 };

    const caption = step === 1 ? `Task: ${instruction}` : "Result of the last action — current state:";
    const callMessages = [...history, treeMessage(current.appName, current.treeText, caption)];

    let call: { name: string; args: Record<string, unknown>; id?: string } | undefined;
    let realResponse: AIMessage | undefined;
    let lastText = "";
    for (let attempt = 0; attempt <= MAX_TOOL_CALL_RETRIES; attempt++) {
      if (attempt > 0) {
        callMessages.push(
          new HumanMessage(
            "You did not call a tool. You must call exactly one of the available computer_* tools now — do not respond with plain text.",
          ),
        );
      }

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
      if (toolCalls.length > 0) {
        call = toolCalls[0];
        realResponse = response;
        break;
      }
      const fake = extractFakeToolCall(response.content);
      if (fake && (byName[fake.name] || fake.name === "computer_finish" || fake.name === "computer_fail")) {
        call = { name: fake.name, args: fake.args, id: `fake_${step}` };
        break;
      }
      lastText = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    }

    if (!call) {
      return { status: "failed", summary: lastText || "Model did not call a tool or produce a summary.", steps: step - 1 };
    }
    // Push the real API response when we have one — preserves its id/
    // response_metadata for the next turn instead of a hand-built stand-in.
    // Only the text-embedded fallback path (no genuine tool_calls) needs a
    // synthetic AIMessage.
    history.push(realResponse ?? new AIMessage({ content: "", tool_calls: [call] }));

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

    // Re-read whichever app is now frontmost — opening/switching apps
    // changes it, and pidRef feeds the next click/scroll's target too.
    current = await describeCurrentScreen();
    pidRef.current = current.pid;
  }

  return { status: "max_steps", summary: `Reached the ${maxSteps}-step limit without finishing.`, steps: maxSteps };
}
