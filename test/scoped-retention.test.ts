import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import test from "node:test";

import { createLaqu } from "../src/index.js";
import type { LaquEvent, LaquTaskEvent } from "../src/events.js";
import { TaskStore } from "../src/task-store.js";
import type { StreamTarget } from "../src/types.js";

class MemoryStream implements StreamTarget {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  events(format: "json" | "ndjson"): LaquEvent[] {
    const output = this.chunks.join("");
    return format === "json"
      ? (JSON.parse(output) as LaquEvent[])
      : output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as LaquEvent);
  }
}

for (const format of ["human", "json", "ndjson"] as const) {
  test(`${format}: a flushed manual success cannot discard an active scope's later failure`, async () => {
    const stderr = new MemoryStream();
    const runtime = createLaqu({ stderr, env: {}, format, retention: { maxTerminalTasks: 0 } });
    const original = new Error("failure after flushing success");
    try {
      await rejects(
        runtime.task("late failure", async (task) => {
          task.succeed("temporary success");
          await runtime.flush();
          await runtime.flush();
          throw original;
        }),
        (error) => error === original,
      );
    } finally {
      await runtime.close();
    }
    if (format !== "human") {
      const events = stderr.events(format);
      const terminal = events
        .filter((event): event is LaquTaskEvent => event.type === "task")
        .at(-1);
      strictEqual(terminal?.task.status, "failed");
      strictEqual(terminal?.task.message, original.message);
      const summary = events.find((event) => event.type === "summary");
      deepStrictEqual(summary?.tasks, {
        total: 1,
        running: 0,
        succeeded: 0,
        failed: 1,
        cancelled: 0,
        skipped: 0,
      });
    } else {
      strictEqual(stderr.chunks.join("").includes(original.message), true);
    }
  });
}

for (const progressPolicy of ["silent", "never"] as const) {
  test(`${progressPolicy}: pruning does not replace a scoped callback rejection`, async () => {
    const stderr = new MemoryStream();
    const runtime = createLaqu({
      stderr,
      env: {},
      progressPolicy,
      retention: { maxTerminalTasks: 0 },
    });
    const original = new Error("silent scope failed");
    try {
      await rejects(
        runtime.task("silent failure", (task) => {
          task.succeed();
          throw original;
        }),
        (error) => error === original,
      );
    } finally {
      await runtime.close();
    }
    strictEqual(stderr.chunks.length, 0);
  });
}

test("retention pressure from unrelated tasks cannot evict an unfinished scope", async () => {
  const stderr = new MemoryStream();
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    retention: { maxTerminalTasks: 1 },
  });
  const original = new Error("active scope failed under pressure");
  try {
    await rejects(
      runtime.task("active scope", async (task) => {
        task.succeed();
        for (let index = 0; index < 4; index++) {
          runtime.createTask(`unrelated ${index}`).succeed();
          await runtime.flush();
        }
        throw original;
      }),
      (error) => error === original,
    );
  } finally {
    await runtime.close();
  }
  const summary = stderr.events("ndjson").find((event) => event.type === "summary");
  deepStrictEqual(summary?.tasks, {
    total: 5,
    running: 0,
    succeeded: 4,
    failed: 1,
    cancelled: 0,
    skipped: 0,
  });
});

test("an already-aborted scope remains available for cancellation and original error delivery", async () => {
  const stderr = new MemoryStream();
  const signal = AbortSignal.abort();
  const original = new Error("aborted callback failure");
  const runtime = createLaqu({
    stderr,
    env: {},
    format: "ndjson",
    retention: { maxTerminalTasks: 0 },
  });
  try {
    await rejects(
      runtime.task("aborted scope", { signal }, async () => {
        await runtime.flush();
        await runtime.flush();
        throw original;
      }),
      (error) => error === original,
    );
  } finally {
    await runtime.close();
  }
  const summary = stderr.events("ndjson").find((event) => event.type === "summary");
  deepStrictEqual(summary?.tasks, {
    total: 1,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 1,
    skipped: 0,
  });
});

test("releasing an active scope restores zero-retention pruning and keeps the final summary", () => {
  const store = new TaskStore({ maxTerminalTasks: 0 });
  const id = store.createTask("protected scope");
  store.retainForScope(id);
  store.update(id, { status: "succeeded" });
  store.snapshot();
  store.snapshot();
  strictEqual(store.retentionStats().retainedTasks, 1);
  store.forceTerminalUpdate(id, { status: "failed", message: "late failure" });
  store.releaseScope(id);
  store.releaseScope(id);
  store.snapshot();
  const final = store.snapshot();
  strictEqual(store.retentionStats().retainedTasks, 0);
  deepStrictEqual(final.summary, {
    total: 1,
    running: 0,
    succeeded: 0,
    failed: 1,
    cancelled: 0,
    skipped: 0,
  });
});
