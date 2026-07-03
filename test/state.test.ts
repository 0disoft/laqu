import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import {
  advanceProgress,
  ratioProgress,
  setCompletedProgress,
  setTotalProgress,
  TaskStore,
} from "../src/task-store.js";

test("progress math clamps overrun without throwing", () => {
  const progress = setCompletedProgress(12, setTotalProgress(10, 0));

  deepStrictEqual(progress, {
    kind: "determinate",
    current: 12,
    total: 10,
    ratio: 1,
    overrun: true,
  });
});

test("advance is explicit delta and setCompleted is explicit absolute", () => {
  const base = setTotalProgress(10, 2);
  const advanced = advanceProgress(3, base);
  const completed = setCompletedProgress(3, base);

  strictEqual(advanced.kind, "determinate");
  strictEqual(completed.kind, "determinate");
  if (advanced.kind === "determinate" && completed.kind === "determinate") {
    strictEqual(advanced.current, 5);
    strictEqual(completed.current, 3);
  }
});

test("weighted child aggregate is derived from children", () => {
  const store = new TaskStore();
  const parent = store.createTask("parent");
  store.createTask("one", { ratio: 0.25, weight: 1 }, parent);
  store.createTask("two", { ratio: 1, weight: 3 }, parent);

  const snapshot = store.snapshot();
  const task = snapshot.tasks[0];
  strictEqual(task?.aggregate.kind, "ratio");
  if (task?.aggregate.kind === "ratio") {
    strictEqual(task.aggregate.ratio, 0.8125);
  }
});

test("indeterminate child produces mixed aggregate instead of false percentage", () => {
  const store = new TaskStore();
  const parent = store.createTask("parent");
  store.createTask("known", { ratio: 0.5 }, parent);
  const unknown = store.createTask("unknown", {}, parent);
  store.update(unknown, { progress: { kind: "indeterminate" } });

  strictEqual(store.snapshot().tasks[0]?.aggregate.kind, "mixed");
});

test("ratio progress clamps negative and overrun values", () => {
  deepStrictEqual(ratioProgress(-1), { kind: "ratio", ratio: 0, overrun: false });
  deepStrictEqual(ratioProgress(2), { kind: "ratio", ratio: 1, overrun: true });
});
