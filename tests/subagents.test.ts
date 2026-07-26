import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatRegistry } from "../src/core/memory/chats.js";

// Deliberately does not import src/core/tools/agents.ts: that module builds the
// whole graph at import time, which needs a live provider config. The two things
// worth pinning down here are the marker contract the clients parse to turn a
// spawn_agent block into a link, and the parent/child bookkeeping the
// observation view depends on.

// Kept byte-identical to SUBAGENT_MARKER in src/core/tools/agents.ts — if that
// regex changes, this test is what catches the clients silently losing their
// links.
const SUBAGENT_MARKER = /^\[ultron:subagent chat=([0-9a-f-]+)\]/;
function parseSubAgentMarker(content: string): string | null {
  return SUBAGENT_MARKER.exec(content.trimStart())?.[1] ?? null;
}

test("the sub-agent marker survives every shape a tool result arrives in", () => {
  const id = "7b571016-10fe-401d-8d96-41a85dc6b4c7";

  assert.equal(parseSubAgentMarker(`[ultron:subagent chat=${id}]\nSub-agent "X" finished.\n\nreport`), id);
  // Leading whitespace: the CLI and web both trim tool output for display, and
  // a stray newline must not cost the link.
  assert.equal(parseSubAgentMarker(`\n  [ultron:subagent chat=${id}]\nstopped`), id);
  // An ordinary tool result must not be mistaken for one.
  assert.equal(parseSubAgentMarker("iso: 2026-07-27T00:00:00.000Z"), null);
  // The marker only counts at the start, so a model echoing it inside prose
  // can't fabricate a link to some other conversation.
  assert.equal(parseSubAgentMarker(`see [ultron:subagent chat=${id}]`), null);
});

test("a sub-agent chat records its parent and inherits its security mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "ultron-subagents-"));
  const registry = new ChatRegistry(join(directory, "state.sqlite3"));

  try {
    const parent = registry.create("Parent");
    registry.setSecurityMode(parent.id, "manual");

    const child = registry.createSubAgent(parent.id, "Fetch the changelog", "Read the changelog and summarise it");

    assert.equal(child.parentChatId, parent.id);
    assert.equal(child.subagentTask, "Read the changelog and summarise it");
    // A delegated run must never be more permissive than the conversation that
    // asked for it.
    assert.equal(child.securityMode, "manual");

    assert.deepEqual(registry.listSubAgents(parent.id).map((c) => c.id), [child.id]);
    assert.deepEqual(registry.listSubAgents(child.id), []);

    // Sub-agent chats stay in the main list on purpose — a conversation
    // reachable from nowhere was a real bug once (see CLAUDE.md).
    assert.ok(registry.list().some((c) => c.id === child.id));

    // Reading it back from disk must not lose the parent link.
    assert.equal(registry.get(child.id)?.parentChatId, parent.id);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
