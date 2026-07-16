// Serializes every graph execution (a normal streamed turn, a spawn_agent
// wake-up note — see tools/agents.ts, a scheduled-task run) that targets
// the same thread_id, within this process.
//
// Without this, a fast spawn_agent sub-agent finishing while the user's own
// turn on the same parent chat was still streaming would fire its wake-up
// graph.invoke() concurrently with that live graph.stream() — two Pregel
// runs reading and writing the same SQLite-backed checkpoint thread at
// once. Observed effect: the live reply picked up the wake-up's injected
// note mid-generation and echoed raw tool/report text into what should
// have been a normal answer. Queuing every call for a given thread_id
// through here makes that structurally impossible — the second call simply
// waits for the first to fully finish (including its whole `for await`
// stream, if the wrapped function has one) before it starts.
//
// Different thread_ids never wait on each other — three sub-agents running
// against three different execution chats stay fully parallel; only calls
// that target the *same* thread_id are serialized.

const queues = new Map<string, Promise<unknown>>();

export function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(threadId) ?? Promise.resolve();
  // Chain onto prior regardless of whether it succeeded or failed — one
  // stuck/failed turn must never permanently jam a thread's queue.
  const run = prior.then(fn, fn);
  queues.set(threadId, run.then(
    () => undefined,
    () => undefined,
  ));
  return run;
}
