import { rejects, strictEqual } from "node:assert";
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
  const runtime = createLaqu({ stdout, stderr, format: "json", env: {}, streamCapability: "tty" });

  const task = runtime.createTask("json-task", { ratio: 0.5 });
  task.succeed();
  await runtime.close();

  strictEqual(stdout.text(), "");
  strictEqual(stderr.text().includes('"schema":"laqu.event"'), true);
  strictEqual(stderr.text().includes('"version":1'), true);
  strictEqual(stderr.text().includes('"type":"task"'), true);
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
