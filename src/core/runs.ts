// In-process registry of graph runs that aren't tied to a single HTTP
// request/response — currently just spawn_agent's background executions
// (see tools/agents.ts). A normal chat turn already has its own
// request-scoped AbortController in server.ts/cli's index.ts; this exists
// so a *background* run can still be found and stopped from the web UI
// (POST /api/stop, same button as any other chat) and so a browser tab that
// opens that chat while it's running can attach to its live output instead
// of only ever seeing the finished result.
//
// Deliberately process-local (a plain Map, no persistence): this project's
// only cross-process shared state is the SQLite file itself (see
// checkpointer.ts/chats.ts) — a run started by one process (say, the web
// server) is only ever observable/stoppable from that same process, which
// is fine since spawn_agent always runs in whichever process evaluated the
// tool call.

export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; summary: string }
  | { type: "tool_result"; name: string; content: string }
  | { type: "done" }
  | { type: "aborted" }
  | { type: "error"; message: string };

interface RunHandle {
  controller: AbortController;
  subscribers: Set<(event: RunEvent) => void>;
  // Every event emitted so far this run, replayed to a subscriber that
  // attaches mid-stream (see subscribeToRun) — without this, switching to
  // another chat and back only ever showed text/tool events emitted
  // *after* re-attaching, not what had already streamed while the tab was
  // elsewhere. Scoped to a single run's lifetime (cleared with the handle
  // in end()), so this never accumulates across runs.
  history: RunEvent[];
}

const runs = new Map<string, RunHandle>();

export interface ActiveRun {
  signal: AbortSignal;
  emit: (event: RunEvent) => void;
  end: () => void;
}

// Registers chatId as running and returns the handle the caller streams
// through. Only one background run per chat is tracked at a time — starting
// a second one for the same chatId replaces the first in the registry
// (the first's own emit/end calls become no-ops for subscriber purposes
// once replaced, since they operate on a handle no longer in the map).
export function beginRun(chatId: string): ActiveRun {
  const controller = new AbortController();
  const handle: RunHandle = { controller, subscribers: new Set(), history: [] };
  runs.set(chatId, handle);
  return {
    signal: controller.signal,
    emit: (event) => {
      handle.history.push(event);
      for (const listener of handle.subscribers) listener(event);
    },
    end: () => {
      if (runs.get(chatId) === handle) runs.delete(chatId);
    },
  };
}

export function isRunning(chatId: string): boolean {
  return runs.has(chatId);
}

// Returns true if a run was found (and thus aborted), false if the chat
// had no active background run to stop.
export function abortRun(chatId: string): boolean {
  const handle = runs.get(chatId);
  if (!handle) return false;
  handle.controller.abort();
  return true;
}

// Returns an unsubscribe function, or undefined if the chat has no active
// run to attach to (caller should fall back to showing static history).
// Replays everything emitted so far before the new listener starts
// receiving live events, so a client attaching mid-run sees the full
// accumulated output, not just what's emitted from this point on.
export function subscribeToRun(chatId: string, listener: (event: RunEvent) => void): (() => void) | undefined {
  const handle = runs.get(chatId);
  if (!handle) return undefined;
  for (const event of handle.history) listener(event);
  handle.subscribers.add(listener);
  return () => handle.subscribers.delete(listener);
}
