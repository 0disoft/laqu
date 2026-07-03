import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { LAQU_EVENT_SCHEMA, LAQU_EVENT_SCHEMA_VERSION, taskEvent } from "../src/events.js";
import { TaskStore } from "../src/task-store.js";

test("task event schema is versioned and nests task payload", () => {
  const store = new TaskStore();
  const id = store.createTask("evented", { ratio: 0.5 });
  const snapshot = store.snapshot().tasks[0];

  strictEqual(id, "task-1");
  strictEqual(snapshot?.id, id);
  if (snapshot === undefined) {
    throw new Error("missing task snapshot");
  }

  const event = taskEvent(snapshot);

  strictEqual(event.schema, LAQU_EVENT_SCHEMA);
  strictEqual(event.version, LAQU_EVENT_SCHEMA_VERSION);
  strictEqual(event.type, "task");
  deepStrictEqual(event.task.progress, { kind: "ratio", ratio: 0.5, overrun: false });
});

test("task event progress preserves overrun separately from clamped ratio", () => {
  const store = new TaskStore();
  store.createTask("overrun", { total: 1, completed: 2 });
  const snapshot = store.snapshot().tasks[0];
  if (snapshot === undefined) {
    throw new Error("missing task snapshot");
  }

  deepStrictEqual(taskEvent(snapshot).task.progress, { kind: "ratio", ratio: 1, overrun: true });
});
