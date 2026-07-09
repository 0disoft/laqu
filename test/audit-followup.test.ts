import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import test from "node:test";

import { createLaqu } from "../src/index.js";
import type { LaquEvent, LaquTaskEvent } from "../src/events.js";
import type { StreamTarget } from "../src/types.js";

class FakeStream implements StreamTarget {
  readonly chunks: string[] = [];
  isTTY = false;
  columns = 80;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

test("scoped close called inside the callback defers final summary until the task resolves", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, format: "json", streamCapability: "pipe" });

  const result = await runtime.task("close during scope", async () => {
    await runtime.close();
    return 9;
  });

  const events = JSON.parse(stderr.text()) as LaquEvent[];
  const summary = events.find((event) => event.type === "summary");
  const taskEvents = events.filter(
    (event): event is LaquTaskEvent =>
      event.type === "task" && event.task.title === "close during scope",
  );

  strictEqual(result, 9);
  strictEqual(taskEvents.at(-1)?.task.status, "succeeded");
  deepStrictEqual(summary?.tasks, {
    total: 1,
    running: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  });
});

test("scoped task failure disposes the task handle and abort listener", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, format: "json", streamCapability: "pipe" });
  const controller = new AbortController();
  const signal = controller.signal;
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  let activeAbortListeners = 0;

  signal.addEventListener = ((type, listener, options) => {
    if (type === "abort") {
      activeAbortListeners += 1;
    }
    addEventListener(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type, listener, options) => {
    if (type === "abort") {
      activeAbortListeners -= 1;
    }
    removeEventListener(type, listener, options);
  }) as AbortSignal["removeEventListener"];

  await rejects(
    runtime.task("throws during scope", { signal }, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  strictEqual(activeAbortListeners, 0);
  await runtime.close();

  const events = JSON.parse(stderr.text()) as LaquEvent[];
  const summary = events.find((event) => event.type === "summary");
  const taskEvents = events.filter(
    (event): event is LaquTaskEvent =>
      event.type === "task" && event.task.title === "throws during scope",
  );

  strictEqual(taskEvents.at(-1)?.task.status, "failed");
  strictEqual(taskEvents.at(-1)?.task.message, "boom");
  deepStrictEqual(summary?.tasks, {
    total: 1,
    running: 0,
    succeeded: 0,
    failed: 1,
    cancelled: 0,
    skipped: 0,
  });
});

test("scoped close still defers after the callback manually completes the task", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, format: "json", streamCapability: "pipe" });

  const result = await runtime.task("manual complete before close", async (task) => {
    task.succeed("done");
    await runtime.close();
    runtime.log("callback still owns the runtime");
    return 12;
  });

  const events = JSON.parse(stderr.text()) as LaquEvent[];
  const summary = events.find((event) => event.type === "summary");
  const taskEvents = events.filter(
    (event): event is LaquTaskEvent =>
      event.type === "task" && event.task.title === "manual complete before close",
  );

  strictEqual(result, 12);
  strictEqual(
    events.some((event) => event.type === "log"),
    true,
  );
  strictEqual(taskEvents.at(-1)?.task.status, "succeeded");
  strictEqual(taskEvents.at(-1)?.task.message, "done");
  deepStrictEqual(summary?.tasks, {
    total: 1,
    running: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  });
});

test("parent aggregate task event timestamp advances when a child changes progress", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const stderr = new FakeStream();
    const runtime = createLaqu({ stderr, env: {}, format: "ndjson", streamCapability: "pipe" });
    const parent = runtime.createTask("parent");
    const child = parent.child("child", { ratio: 0 });
    await runtime.flush();

    now = 2_000;
    child.setRatio(1);
    await runtime.flush();
    await runtime.close();

    const parentEvents = stderr
      .text()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LaquEvent)
      .filter(
        (event): event is LaquTaskEvent => event.type === "task" && event.task.id === parent.id,
      );

    strictEqual(parentEvents.length >= 2, true);
    strictEqual(parentEvents.at(0)?.createdAt, 1_000);
    strictEqual(parentEvents.at(-1)?.createdAt, 2_000);
  } finally {
    Date.now = originalNow;
  }
});

test("public skip API emits skipped task status and summary count", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, format: "json", streamCapability: "pipe" });
  const task = runtime.createTask("cache warmup");

  task.skip("already warm");
  await runtime.close();

  const events = JSON.parse(stderr.text()) as LaquEvent[];
  const taskEvents = events.filter(
    (event): event is LaquTaskEvent => event.type === "task" && event.task.title === "cache warmup",
  );
  const summary = events.find((event) => event.type === "summary");

  strictEqual(taskEvents.at(-1)?.task.status, "skipped");
  strictEqual(taskEvents.at(-1)?.task.message, "already warm");
  deepStrictEqual(summary?.tasks, {
    total: 1,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 1,
  });
});
