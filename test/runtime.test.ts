import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createLaqu } from "../src/index.js";
import { unknownToRejectionError } from "../src/runtime.js";
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

class DeferredDrainStream extends EventEmitter implements StreamTarget {
  readonly chunks: string[] = [];
  isTTY = false;
  columns = 80;
  failNext = true;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.failNext) {
      this.failNext = false;
      return false;
    }
    return true;
  }

  text(): string {
    return this.chunks.join("");
  }
}

class ManualAbortSignal {
  aborted = false;
  readonly listeners = new Set<() => void>();

  addEventListener(event: string, listener: unknown): void {
    if (event === "abort" && typeof listener === "function") {
      this.listeners.add(listener as () => void);
    }
  }

  removeEventListener(event: string, listener: unknown): void {
    if (event === "abort" && typeof listener === "function") {
      this.listeners.delete(listener as () => void);
    }
  }

  abort(): void {
    this.aborted = true;
    for (const listener of this.listeners) {
      listener();
    }
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

test("json format emits a parseable event array", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "json",
    streamCapability: "pipe",
  });

  const task = runtime.createTask("json-array", { ratio: 0.5 });
  task.succeed();
  runtime.log("late log");
  await runtime.close();

  const events = JSON.parse(stderr.text()) as readonly {
    readonly type?: string;
    readonly schema?: string;
  }[];
  strictEqual(Array.isArray(events), true);
  strictEqual(
    events.every((event) => event.schema === "laqu.event"),
    true,
  );
  strictEqual(events.at(-1)?.type, "summary");
  strictEqual(events.filter((event) => event.type === "summary").length, 1);
  strictEqual(
    events.some((event) => event.type === "log"),
    true,
  );
});

test("ndjson format keeps newline-delimited event output", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    streamCapability: "pipe",
  });

  const task = runtime.createTask("ndjson-stream", { ratio: 0.5 });
  task.succeed();
  await runtime.close();

  const lines = stderr.text().trim().split("\n").filter(Boolean);
  strictEqual(lines.length > 1, true);
  const events = lines.map(
    (line) => JSON.parse(line) as { readonly type?: string; readonly schema?: string },
  );
  strictEqual(
    events.every((event) => event.schema === "laqu.event"),
    true,
  );
  strictEqual(events.at(-1)?.type, "summary");
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

test("scoped task failure overrides an earlier manual success", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    streamCapability: "pipe",
  });
  const error = new Error("late failure");

  await rejects(
    runtime.task("manual success then throw", (task) => {
      task.succeed("done");
      throw error;
    }),
    error,
  );
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
          readonly task?: { readonly status?: string; readonly message?: string };
        },
    )
    .filter((event) => event.type === "task");
  const finalTaskEvent = taskEvents.at(-1);
  strictEqual(finalTaskEvent?.task?.status, "failed");
  strictEqual(finalTaskEvent?.task?.message, "late failure");
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

test("pipe plain output disables ANSI color by default", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    streamCapability: "pipe",
    progressPolicy: "plain",
  });

  const task = runtime.createTask("plain", { ratio: 1 });
  task.succeed();
  await runtime.close();

  strictEqual(stderr.text().includes("\u001b["), false);
});

test("FORCE_COLOR=0 disables ANSI color on tty output", async () => {
  const stderr = new FakeStream();
  stderr.isTTY = true;
  const runtime = createLaqu({
    stderr,
    env: { FORCE_COLOR: "0" },
    streamCapability: "tty",
    progressPolicy: "plain",
  });

  const task = runtime.createTask("no color", { ratio: 1 });
  task.succeed();
  await runtime.close();

  strictEqual(stderr.text().includes("\u001b["), false);
});

test("scoped success without message preserves the latest message", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    streamCapability: "pipe",
  });

  await runtime.task("message scope", (task) => {
    task.setMessage("bundling");
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
          readonly task?: { readonly status?: string; readonly message?: string };
        },
    )
    .filter((event) => event.type === "task");
  const finalTaskEvent = taskEvents.at(-1);
  strictEqual(finalTaskEvent?.task?.status, "succeeded");
  strictEqual(finalTaskEvent?.task?.message, "bundling");
});

test("string failures are preserved as task messages", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    streamCapability: "pipe",
  });

  await rejects(
    runtime.task("string failure", () => {
      throw "boom";
    }),
    (error) => {
      strictEqual(error, "boom");
      return true;
    },
  );
  await runtime.close();

  strictEqual(stderr.text().includes('"message":"boom"'), true);
});

test("manual task abort signal cancels the task", async () => {
  const stderr = new FakeStream();
  const controller = new AbortController();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    streamCapability: "pipe",
  });

  runtime.createTask("manual abort", { signal: controller.signal });
  controller.abort();
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
          readonly task?: { readonly status?: string; readonly message?: string };
        },
    )
    .filter((event) => event.type === "task");
  const finalTaskEvent = taskEvents.at(-1);
  strictEqual(finalTaskEvent?.task?.status, "cancelled");
  strictEqual(finalTaskEvent?.task?.message, "aborted");
});

test("runtime close removes abort listeners for unfinished tasks", async () => {
  const stderr = new FakeStream();
  const signal = new ManualAbortSignal();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    streamCapability: "pipe",
  });

  runtime.createTask("pending abort cleanup", { signal: signal as unknown as AbortSignal });
  strictEqual(signal.listeners.size, 1);
  await runtime.close();

  strictEqual(signal.listeners.size, 0);
  signal.abort();
});

test("scoped task result survives runtime close during callback", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, streamCapability: "pipe" });

  const result = await runtime.task("close during scope", async () => {
    await runtime.close();
    return 9;
  });

  strictEqual(result, 9);
  strictEqual(stderr.text().includes("close during scope"), true);
});

test("setTotal preserves a previously known completed count", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    streamCapability: "pipe",
    progressPolicy: "plain",
  });

  const task = runtime.createTask("late total");
  task.setCompleted(5);
  task.setTotal(10);
  await runtime.close();

  strictEqual(stderr.text().includes("50%"), true);
});

test("runtime rejects invalid maxRows values", () => {
  throws(() => createLaqu({ stderr: new FakeStream(), env: {}, maxRows: 0 }), {
    name: "TypeError",
    message: "maxRows must be a safe positive integer",
  });
  throws(() => createLaqu({ stderr: new FakeStream(), env: {}, maxRows: Number.NaN }), {
    name: "TypeError",
    message: "maxRows must be a safe positive integer",
  });
});

test("indeterminate leaf renders as indeterminate instead of mixed", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    streamCapability: "pipe",
    progressPolicy: "plain",
  });

  const task = runtime.createTask("loading");
  task.setIndeterminate("fetching");
  await runtime.close();

  strictEqual(stderr.text().includes("mixed"), false);
  strictEqual(stderr.text().includes("~"), true);
});

test("runtime log retention can drop log output", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    streamCapability: "pipe",
    retention: { maxLogs: 0 },
  });

  runtime.log("dropped");
  await runtime.close();

  strictEqual(stderr.text(), "");
});

test("runtime terminal task retention keeps summary counts for pruned tasks", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "json",
    streamCapability: "pipe",
    retention: { maxTerminalTasks: 0 },
  });

  for (let index = 1; index <= 3; index += 1) {
    const task = runtime.createTask(`task-${index}`);
    task.succeed();
    await runtime.flush();
  }
  await runtime.close();

  const events = JSON.parse(stderr.text()) as readonly {
    readonly type?: string;
    readonly tasks?: {
      readonly total?: number;
      readonly running?: number;
      readonly succeeded?: number;
      readonly failed?: number;
    };
  }[];
  const summary = events.find((event) => event.type === "summary");

  strictEqual(summary?.tasks?.total, 3);
  strictEqual(summary?.tasks?.running, 0);
  strictEqual(summary?.tasks?.succeeded, 3);
  strictEqual(summary?.tasks?.failed, 0);
});

test("runtime rejects new mutations while close is in progress", async () => {
  const stderr = new DeferredDrainStream();
  const runtime = createLaqu({ stderr, env: {}, streamCapability: "pipe" });
  const task = runtime.createTask("closing", { total: 2 });

  const closing = runtime.close();

  throws(() => runtime.createTask("late"), { message: "Laqu runtime is closing" });
  throws(() => runtime.log("late log"), { message: "Laqu runtime is closing" });
  throws(() => task.advance(1), { message: "Laqu runtime is closing" });

  stderr.emit("drain");
  await closing;

  strictEqual(stderr.text().includes("closing"), true);
  strictEqual(stderr.text().includes("late"), false);
});

test("runtime rejects mutations after close", async () => {
  const stderr = new FakeStream();
  const runtime = createLaqu({ stderr, env: {}, streamCapability: "pipe" });
  const task = runtime.createTask("closed", { total: 1 });
  task.succeed();
  await runtime.close();

  throws(() => runtime.createTask("late"), { message: "Laqu runtime is closing" });
  throws(() => runtime.log("late log"), { message: "Laqu runtime is closing" });
  throws(() => task.setMessage("late"), { message: "Laqu runtime is closing" });
});

test("concurrent live runtimes on the same stream fall back to plain rendering", async () => {
  const stderr = new FakeStream();
  stderr.isTTY = true;
  const primary = createLaqu({ stderr, env: {}, streamCapability: "tty" });

  primary.createTask("primary", { ratio: 0.25 });
  await primary.flush();
  const chunksAfterPrimary = stderr.chunks.length;

  const secondary = createLaqu({ stderr, env: {}, streamCapability: "tty" });
  secondary.createTask("secondary", { ratio: 0.5 });
  await secondary.flush();

  const secondaryOutput = stderr.chunks.slice(chunksAfterPrimary).join("");
  strictEqual(secondaryOutput.includes("secondary"), true);
  strictEqual(secondaryOutput.includes("\u001b[?25l"), false);
  strictEqual(secondaryOutput.includes("\u001b[2K"), false);

  await secondary.close();
  await primary.close();

  strictEqual(countOccurrences(stderr.text(), "\u001b[?25l"), 1);
  strictEqual(countOccurrences(stderr.text(), "\u001b[?25h"), 1);
});

test("live stream ownership is released after close", async () => {
  const stderr = new FakeStream();
  stderr.isTTY = true;

  const first = createLaqu({ stderr, env: {}, streamCapability: "tty" });
  first.createTask("first", { ratio: 0.25 });
  await first.close();

  const second = createLaqu({ stderr, env: {}, streamCapability: "tty" });
  second.createTask("second", { ratio: 0.5 });
  await second.close();

  strictEqual(countOccurrences(stderr.text(), "\u001b[?25l"), 2);
  strictEqual(countOccurrences(stderr.text(), "\u001b[?25h"), 2);
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

test("process lifecycle preserves non-Error rejection reasons", () => {
  const reason = { code: "CUSTOM_REJECTION" };
  const error = unknownToRejectionError(reason);

  strictEqual(error.message, "Unhandled promise rejection: Non-Error thrown");
  strictEqual((error as Error & { readonly cause?: unknown }).cause, reason);
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

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

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
