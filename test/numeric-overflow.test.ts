import { deepStrictEqual, strictEqual, throws } from "node:assert";
import test from "node:test";

import { createLaqu, type LaquEvent } from "../src/index.js";
import { advanceProgress, TaskStore } from "../src/task-store.js";

test("counter and determinate advances reject overflow before changing progress", () => {
  for (const options of [{ completed: 1e308 }, { total: 1e308, completed: 1e308 }]) {
    const store = new TaskStore();
    const id = store.createTask("large counter", options);
    const previous = store.getProgress(id);
    throws(() => store.update(id, { progress: advanceProgress(1e308, previous) }), TypeError);
    strictEqual(store.getProgress(id), previous);
    store.update(id, { progress: advanceProgress(-1e308, previous) });
    const recovered = store.getProgress(id);
    if (recovered.kind !== "counter" && recovered.kind !== "determinate")
      throw new Error("missing counter");
    strictEqual(recovered.current, 0);
  }
});

for (const maxTerminalTasks of [0, 1_000]) {
  for (const [first, second, ratio] of [
    [1e308, 1e308, 0.5],
    [1e308, 5e307, 0.5],
    [Number.MIN_VALUE, Number.MIN_VALUE, 0.5],
  ] as const) {
    test(`weighted ratios stay finite through pruning (${first}, ${second}, retention ${maxTerminalTasks})`, () => {
      const store = new TaskStore({ maxTerminalTasks });
      const parent = store.createTask("parent");
      const a = store.createTask("a", { weight: first, ratio: 0.25 }, parent);
      const b = store.createTask(
        "b",
        { weight: second, ratio: first === second ? 0.75 : 1 },
        parent,
      );
      function check() {
        deepStrictEqual(store.snapshot().tasks[0]?.aggregate, {
          kind: "ratio",
          ratio,
          overrun: false,
        });
      }
      check();
      store.update(a, { status: "succeeded" });
      check();
      check();
      check();
      store.update(b, { status: "succeeded" });
      check();
      check();
      check();
    });
  }
}

test("public numeric events remain finite after rejecting overflow and recovering", async () => {
  const chunks: string[] = [];
  const runtime = createLaqu({
    statusStream: {
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
    },
    env: {},
    format: "ndjson",
  });
  const task = runtime.createTask("counter", { completed: 1e308 });
  throws(() => task.advance(1e308), TypeError);
  task.setCompleted(2);
  task.succeed();
  const parent = runtime.createTask("parent");
  parent.child("a", { weight: 1e308, ratio: 1 }).succeed();
  parent.child("b", { weight: 1e308, ratio: 1 }).succeed();
  parent.succeed();
  await runtime.close();
  strictEqual(chunks.join("").includes(":null"), false);
  const events = chunks
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)) as LaquEvent[];
  const finalParent = events
    .filter((event) => event.type === "task" && event.task.id === parent.id)
    .at(-1);
  if (finalParent?.type !== "task") throw new Error("missing parent event");
  deepStrictEqual(finalParent.task.progress, { kind: "ratio", ratio: 1, overrun: false });
});
