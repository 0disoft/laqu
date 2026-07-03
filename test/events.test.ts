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

test("task event omits absent optional task fields", () => {
  const store = new TaskStore();
  store.createTask("root");
  const snapshot = store.snapshot().tasks[0];
  if (snapshot === undefined) {
    throw new Error("missing task snapshot");
  }

  const event = taskEvent(snapshot);
  const wire = JSON.parse(JSON.stringify(event)) as {
    readonly task?: Record<string, unknown>;
  };

  strictEqual(Object.hasOwn(event.task, "parentId"), false);
  strictEqual(Object.hasOwn(event.task, "message"), false);
  strictEqual(Object.hasOwn(event.task, "detail"), false);
  strictEqual(Object.hasOwn(wire.task ?? {}, "parentId"), false);
  strictEqual(Object.hasOwn(wire.task ?? {}, "message"), false);
  strictEqual(Object.hasOwn(wire.task ?? {}, "detail"), false);
});

test("task event includes present optional task fields", () => {
  const store = new TaskStore();
  const parentId = store.createTask("parent");
  store.createTask("child", { message: "ready", detail: "chunk 1" }, parentId);
  const child = store.snapshot().tasks[0]?.children[0];
  if (child === undefined) {
    throw new Error("missing child task snapshot");
  }

  const event = taskEvent(child);

  strictEqual(event.task.parentId, parentId);
  strictEqual(event.task.message, "ready");
  strictEqual(event.task.detail, "chunk 1");
  strictEqual(Object.hasOwn(event.task, "parentId"), true);
  strictEqual(Object.hasOwn(event.task, "message"), true);
  strictEqual(Object.hasOwn(event.task, "detail"), true);
});
