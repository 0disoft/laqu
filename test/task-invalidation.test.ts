import { deepStrictEqual, ok } from "node:assert";
import test from "node:test";

import { TaskStore } from "../src/task-store.js";

for (const recordOutput of [false, true]) {
  test(`batched deep updates invalidate ancestors once between snapshots (records ${recordOutput})`, () => {
    const store = new TaskStore({ recordOutput });
    const depth = 64;
    const updates = 2_000;
    let leaf = store.createTask("root");
    for (let index = 1; index < depth; index++) {
      leaf = store.createTask("child", { ratio: 0 }, leaf);
    }
    const before = store.snapshot().tasks[0];
    const originalGet = Map.prototype.get;
    let reads = 0;
    try {
      Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
        if (typeof key === "string" && key.startsWith("task-")) reads++;
        return originalGet.call(this, key);
      };
      for (let index = 1; index <= updates; index++) {
        store.update(leaf, { progress: { kind: "ratio", ratio: index / updates, overrun: false } });
      }
    } finally {
      Map.prototype.get = originalGet;
    }
    // Bound task lookups, not wall time: repeated updates must not rewalk the entire ancestry.
    ok(reads <= updates + depth, `${reads} lookups for ${updates} updates at depth ${depth}`);
    deepStrictEqual(store.snapshot().tasks[0]?.aggregate, {
      kind: "ratio",
      ratio: 1,
      overrun: false,
    });
    deepStrictEqual(before?.aggregate, { kind: "ratio", ratio: 0, overrun: false });
    store.update(leaf, { progress: { kind: "ratio", ratio: 0.5, overrun: false } });
    deepStrictEqual(store.snapshot().tasks[0]?.aggregate, {
      kind: "ratio",
      ratio: 0.5,
      overrun: false,
    });
  });
}

test("a lifecycle record can rebuild a dirty ancestor cache before another child update", () => {
  const store = new TaskStore({ recordOutput: true });
  const parent = store.createTask("parent");
  const child = store.createTask("child", { ratio: 0 }, parent);
  store.snapshot(true);
  store.update(child, { progress: { kind: "ratio", ratio: 0.25, overrun: false } });
  store.update(parent, { status: "failed" }); // Records a snapshot without consuming dirty ids.
  store.update(child, { progress: { kind: "ratio", ratio: 0.75, overrun: false } });
  const snapshot = store.snapshot(true);
  deepStrictEqual(snapshot.tasks.find((task) => task.id === parent)?.aggregate, {
    kind: "ratio",
    ratio: 0.75,
    overrun: false,
  });
  const record = snapshot.outputRecords?.find(
    (entry) => entry.kind === "task" && entry.task.id === parent,
  );
  if (record?.kind !== "task") throw new Error("missing lifecycle snapshot");
  deepStrictEqual(record.task.aggregate, { kind: "ratio", ratio: 0.25, overrun: false });
});
