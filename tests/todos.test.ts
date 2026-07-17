import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TodoRegistry } from "../src/core/memory/todos.js";

test("clearing a chat removes the persisted task list", () => {
  const directory = mkdtempSync(join(tmpdir(), "ultron-todos-"));
  const registry = new TodoRegistry(join(directory, "state.sqlite3"));

  try {
    registry.set("chat-1", [{ id: "old", content: "old request", status: "in_progress" }]);
    assert.equal(registry.get("chat-1").length, 1);

    registry.clear("chat-1");

    assert.deepEqual(registry.get("chat-1"), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
