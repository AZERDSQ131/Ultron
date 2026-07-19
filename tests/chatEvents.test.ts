import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatEventRegistry } from "../src/core/memory/chatEvents.js";

test("chat events preserve order and support incremental reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "ultron-events-"));
  const registry = new ChatEventRegistry(join(directory, "state.sqlite3"));

  try {
    const human = registry.append("chat-1", "human", "cli", "hello");
    const ai = registry.append("chat-1", "ai", "cli", "hi");
    registry.append("chat-2", "human", "telegram", "other");

    assert.equal(registry.latestId("chat-1"), ai.id);
    assert.deepEqual(registry.listAfter("chat-1", human.id).map((event) => event.content), ["hi"]);
    assert.deepEqual(registry.listAfter("chat-1", 0).map((event) => event.source), ["cli", "cli"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
