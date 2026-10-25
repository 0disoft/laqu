import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { JsonEventRenderer, PlainLogRenderer, type Frame } from "../src/renderer.js";
import { TaskStore } from "../src/task-store.js";
import { compileTheme } from "../src/theme.js";

test("incremental output leaves already-emitted retained terminal tasks out of the next frame", () => {
  const store = new TaskStore({ recordOutput: true });
  for (let index = 0; index < 1_000; index++) {
    store.update(store.createTask("done"), { status: "succeeded" });
  }
  strictEqual(store.snapshot(true).tasks.length, 1_000);
  strictEqual(store.snapshot(true).tasks.length, 0);
  const id = store.createTask("next");
  deepStrictEqual(
    store.snapshot(true).tasks.map((task) => task.id),
    [id],
  );
  strictEqual(store.snapshot().tasks.length, 1_001);
});

test("snapshot caching invalidates changed ancestors and keeps old snapshots immutable", () => {
  const store = new TaskStore();
  const parent = store.createTask("parent");
  const child = store.createTask("child", { ratio: 0.25 }, parent);
  const before = store.snapshot().tasks[0];
  store.update(parent, { message: "parent changed" });
  const messageOnly = store.snapshot().tasks[0];
  strictEqual(messageOnly?.children[0], before?.children[0]);
  store.update(child, { progress: { kind: "ratio", ratio: 0.75, overrun: false } });
  deepStrictEqual(store.snapshot().tasks[0]?.aggregate, {
    kind: "ratio",
    ratio: 0.75,
    overrun: false,
  });
  deepStrictEqual(before?.aggregate, { kind: "ratio", ratio: 0.25, overrun: false });
  strictEqual(before?.message, undefined);
});

for (const format of ["plain", "json"] as const) {
  test(`${format}: incremental and full snapshots produce the same transitions, aggregates and pruning`, () => {
    const stores = [0, 1].map(() => new TaskStore({ recordOutput: true, maxTerminalTasks: 0 }));
    const renderers = stores.map(() =>
      format === "json"
        ? new JsonEventRenderer()
        : new PlainLogRenderer(compileTheme({ useColor: false })),
    );
    function normalized(frame: Frame) {
      return frame.kind === "json"
        ? frame.events.map(({ createdAt: _createdAt, ...event }) => event)
        : frame;
    }
    function compare() {
      const output = stores.map((store, index) =>
        normalized(renderers[index]!.render(store.snapshot(index === 1))),
      );
      deepStrictEqual(output[1], output[0]);
    }
    for (const store of stores) {
      const parent = store.createTask("parent");
      store.createTask("child", { ratio: 0.25, weight: 3 }, parent);
      store.createTask("sibling", { ratio: 0.75 }, parent);
    }
    compare();
    for (const store of stores) {
      store.update("task-2", { progress: { kind: "ratio", ratio: 0.5, overrun: false } });
      store.addLog("between updates");
    }
    compare();
    for (const store of stores) store.update("task-2", { status: "succeeded" });
    compare();
    compare(); // Prune a completed child and retain its weighted contribution.
    compare(); // Remove only its renderer state; do not re-emit unchanged siblings.
    for (const store of stores) store.update("task-3", { detail: "changed sibling" });
    compare();
    for (const store of stores) store.update("task-3", { status: "cancelled" });
    compare();
    compare();
    for (const store of stores)
      store.update("task-1", { status: "failed", message: "late failure" });
    compare();
    compare();
    compare();
    strictEqual(stores[1]?.retentionStats().retainedTasks, 0);
  });
}
