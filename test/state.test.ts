import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import test from "node:test";

import {
  advanceProgress,
  ratioProgress,
  setCompletedProgress,
  setTotalProgress,
  TaskStore,
  type TaskSnapshot,
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

test("large child aggregate stays deterministic under task volume", () => {
  const store = new TaskStore();
  const parent = store.createTask("parent");
  let expectedRatio = 0;

  for (let index = 1; index <= 1000; index += 1) {
    const ratio = index / 1000;
    expectedRatio += ratio;
    store.createTask(`child-${index}`, { ratio }, parent);
  }

  const task = store.snapshot().tasks[0];
  strictEqual(task?.children.length, 1000);
  strictEqual(task?.aggregate.kind, "ratio");
  if (task?.aggregate.kind === "ratio") {
    ok(Math.abs(task.aggregate.ratio - expectedRatio / 1000) < 1e-12);
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

test("zero-weight unknown children do not poison weighted aggregate", () => {
  const store = new TaskStore();
  const parent = store.createTask("parent");
  store.createTask("known", { ratio: 0.5, weight: 1 }, parent);
  store.createTask("unknown", { weight: 0 }, parent);

  const task = store.snapshot().tasks[0];

  strictEqual(task?.aggregate.kind, "ratio");
  if (task?.aggregate.kind === "ratio") {
    strictEqual(task.aggregate.ratio, 0.5);
  }
});

test("ratio progress clamps negative and overrun values", () => {
  deepStrictEqual(ratioProgress(-1), { kind: "ratio", ratio: 0, overrun: false });
  deepStrictEqual(ratioProgress(2), { kind: "ratio", ratio: 1, overrun: true });
});

test("terminal task status cannot be overwritten", () => {
  const store = new TaskStore();
  const id = store.createTask("terminal");

  store.update(id, { status: "cancelled", message: "aborted" });
  store.update(id, { status: "succeeded", message: "done" });
  store.update(id, { progress: setTotalProgress(10, 10), detail: "late" });

  const task = store.snapshot().tasks[0];
  strictEqual(task?.status, "cancelled");
  strictEqual(task?.message, "aborted");
  strictEqual(task?.progress.kind, "none");
  strictEqual(task?.detail, undefined);
});

test("task creation rejects non-finite completed values", () => {
  const store = new TaskStore();

  throws(() => store.createTask("bad completed", { completed: Number.NaN }), {
    name: "TypeError",
    message: "completed must be a finite non-negative number",
  });
});

test("task creation rejects invalid aggregate weights", () => {
  const store = new TaskStore();

  throws(() => store.createTask("bad weight", { weight: Number.POSITIVE_INFINITY }), {
    name: "TypeError",
    message: "weight must be a finite non-negative number",
  });
  throws(() => store.createTask("negative weight", { weight: -1 }), {
    name: "TypeError",
    message: "weight must be a finite non-negative number",
  });
});

test("log retention keeps only the newest records", () => {
  const store = new TaskStore({ maxLogs: 2 });

  store.addLog("one");
  store.addLog("two");
  store.addLog("three");

  const logs = store.snapshot().logs;
  deepStrictEqual(
    logs.map((log) => log.message),
    ["two", "three"],
  );
  deepStrictEqual(
    logs.map((log) => log.sequence),
    [2, 3],
  );
});

test("zero log retention drops log records", () => {
  const store = new TaskStore({ maxLogs: 0 });

  store.addLog("hidden");

  strictEqual(store.snapshot().logs.length, 0);
});

test("task creation rejects invalid log retention limits", () => {
  throws(() => new TaskStore({ maxLogs: -1 }), {
    name: "TypeError",
    message: "maxLogs must be a safe non-negative integer",
  });
  throws(() => new TaskStore({ maxLogs: 1.5 }), {
    name: "TypeError",
    message: "maxLogs must be a safe non-negative integer",
  });
});

test("terminal task retention prunes old terminal leaf tasks after they are snapshotted", () => {
  const store = new TaskStore({ maxTerminalTasks: 2 });

  for (let index = 1; index <= 4; index += 1) {
    const id = store.createTask(`done-${index}`);
    store.update(id, { status: "succeeded" });
    store.snapshot();
  }

  const retained = store.snapshot();

  deepStrictEqual(
    retained.tasks.map((task) => task.title),
    ["done-3", "done-4"],
  );
  deepStrictEqual(retained.summary, {
    total: 4,
    running: 0,
    succeeded: 4,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  });
});

test("zero terminal task retention prunes after the retained task is resnapshotted", () => {
  const store = new TaskStore({ maxTerminalTasks: 0 });
  const id = store.createTask("short-lived");
  store.update(id, { status: "succeeded" });

  const first = store.snapshot();
  const second = store.snapshot();
  const third = store.snapshot();

  strictEqual(first.tasks.length, 1);
  strictEqual(second.tasks.length, 1);
  strictEqual(third.tasks.length, 0);
  deepStrictEqual(third.summary, {
    total: 1,
    running: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  });
  store.update(id, { status: "failed" });
});

test("task creation rejects terminal parents", () => {
  const store = new TaskStore();
  const parent = store.createTask("parent");
  store.update(parent, { status: "succeeded" });

  throws(() => store.createTask("late child", {}, parent), {
    message: `Cannot create child task under terminal task: ${parent}`,
  });
  deepStrictEqual(store.snapshot().summary, {
    total: 1,
    running: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  });
});

test("task creation rejects pruned terminal parents without changing summary", () => {
  const store = new TaskStore({ maxTerminalTasks: 0 });
  const parent = store.createTask("parent");
  store.update(parent, { status: "succeeded" });
  store.snapshot();
  store.snapshot();

  throws(() => store.createTask("late child", {}, parent), {
    message: `Task id was pruned after terminal retention: ${parent}`,
  });

  const snapshot = store.snapshot();
  strictEqual(snapshot.tasks.length, 0);
  deepStrictEqual(snapshot.summary, {
    total: 1,
    running: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  });
});

test("task store rejects non-string public text fields", () => {
  const store = new TaskStore();
  const id = store.createTask("valid");

  throws(() => store.createTask(123 as never), {
    name: "TypeError",
    message: "title must be a string",
  });
  throws(() => store.addLog(123 as never), {
    name: "TypeError",
    message: "message must be a string",
  });
  throws(() => store.update(id, { message: 123 as never }), {
    name: "TypeError",
    message: "message must be a string",
  });
});

test("task creation rejects invalid terminal task retention limits", () => {
  throws(() => new TaskStore({ maxTerminalTasks: -1 }), {
    name: "TypeError",
    message: "maxTerminalTasks must be a safe non-negative integer",
  });
  throws(() => new TaskStore({ maxTerminalTasks: 1.5 }), {
    name: "TypeError",
    message: "maxTerminalTasks must be a safe non-negative integer",
  });
});

test("deep task snapshots are built without recursive traversal", () => {
  const store = new TaskStore();
  let parent = store.createTask("root");

  for (let depth = 1; depth <= 5000; depth += 1) {
    parent = store.createTask(`child-${depth}`, { ratio: 1 }, parent);
  }

  const root = store.snapshot().tasks[0];
  strictEqual(root?.aggregate.kind, "ratio");
  let current: TaskSnapshot | undefined = root;
  let depth = 0;
  while (current !== undefined) {
    depth += 1;
    current = current.children[0];
  }

  strictEqual(depth, 5001);
});
