import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import test from "node:test";

import { createLaqu } from "../src/index.js";
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

test("progress defaults to stderr and keeps stdout clean", async () => {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const runtime = createLaqu({ stdout, stderr, env: {}, streamCapability: "pipe" });

  const task = runtime.createTask("download", { total: 10 });
  task.advance(10);
  task.succeed();
  await runtime.close();

  strictEqual(stdout.text(), "");
  strictEqual(stderr.text().includes("download"), true);
});

test("json progress events still use status stream by default", async () => {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stdout,
    stderr,
    format: "ndjson",
    env: {},
    streamCapability: "tty",
  });

  const task = runtime.createTask("json-task", { ratio: 0.5 });
  task.succeed();
  await runtime.close();

  strictEqual(stdout.text(), "");
  strictEqual(stderr.text().includes('"schema":"laqu.event"'), true);
  strictEqual(stderr.text().includes('"version":1'), true);
  strictEqual(stderr.text().includes('"type":"task"'), true);
  const events = stderr
    .text()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { readonly schema?: unknown });
  strictEqual(
    events.every((event) => event.schema === "laqu.event"),
    true,
  );
});

test("human progress renders themed percentage bar", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    streamCapability: "pipe",
    progressPolicy: "plain",
    theme: {
      progressComplete: "=",
      progressIncomplete: ".",
    },
  });

  runtime.createTask("bar", { ratio: 0.5 });
  await runtime.close();

  strictEqual(stderr.text().includes("[==========..........] 50%"), true);
});

test("scoped task succeeds and closes cleanly", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, streamCapability: "pipe" });

  const result = await runtime.task("scope", async (task) => {
    task.setTotal(2);
    task.advance(2);
    return 42;
  });
  await runtime.close();

  strictEqual(result, 42);
  strictEqual(stderr.text().includes("scope"), true);
});

test("scoped task marks failure and rethrows original error", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, streamCapability: "pipe" });
  const error = new Error("boom");

  await rejects(
    runtime.task("failure", () => {
      throw error;
    }),
    error,
  );
  await runtime.close();

  strictEqual(stderr.text().includes("failure"), true);
  strictEqual(stderr.text().includes("boom"), true);
});

test("aborted scoped task is not overwritten by callback success", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    streamCapability: "pipe",
  });
  const controller = new AbortController();

  const result = await runtime.task("abort scope", { signal: controller.signal }, async () => {
    controller.abort();
    return 7;
  });
  await runtime.close();

  const taskEvents = stderr
    .text()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly type?: string;
          readonly task?: { readonly status?: string };
        },
    )
    .filter((event) => event.type === "task");
  const finalTaskEvent = taskEvents.at(-1);
  strictEqual(result, 7);
  strictEqual(finalTaskEvent?.task?.status, "cancelled");
});

test("process lifecycle handlers are opt-in and disposed on close", async () => {
  const before = processLifecycleListenerCounts();
  const defaultRuntime = createLaqu({
    stderr: new FakeStream(),
    env: {},
    streamCapability: "pipe",
  });
  await defaultRuntime.close();
  deepStrictEqual(processLifecycleListenerCounts(), before);

  const managedRuntime = createLaqu({
    stderr: new FakeStream(),
    env: {},
    streamCapability: "pipe",
    manageProcessLifecycle: true,
  });
  deepStrictEqual(processLifecycleListenerCounts(), {
    SIGINT: before.SIGINT + 1,
    SIGTERM: before.SIGTERM + 1,
    uncaughtException: before.uncaughtException + 1,
    unhandledRejection: before.unhandledRejection + 1,
  });

  await managedRuntime.close();
  deepStrictEqual(processLifecycleListenerCounts(), before);
});

test("dirty progress updates coalesce until explicit flush", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, streamCapability: "pipe" });
  const task = runtime.createTask("coalesce", { total: 10 });
  const writesAfterStart = stderr.chunks.length;

  task.advance(1);
  task.advance(1);
  task.advance(1);

  strictEqual(stderr.chunks.length, writesAfterStart);
  await runtime.flush();
  strictEqual(stderr.text().includes("30%"), true);
  await runtime.close();
});

test("burst progress updates do not emit one frame per mutation", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, streamCapability: "pipe" });
  const task = runtime.createTask("burst", { total: 1000 });
  const writesAfterCreate = stderr.chunks.length;

  for (let index = 0; index < 1000; index += 1) {
    task.advance(1);
  }

  strictEqual(stderr.chunks.length, writesAfterCreate);
  await runtime.flush();
  strictEqual(stderr.text().includes("100%"), true);
  await runtime.close();
});

function processLifecycleListenerCounts(): {
  readonly SIGINT: number;
  readonly SIGTERM: number;
  readonly uncaughtException: number;
  readonly unhandledRejection: number;
} {
  return {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
    uncaughtException: process.listenerCount("uncaughtException"),
    unhandledRejection: process.listenerCount("unhandledRejection"),
  };
}
