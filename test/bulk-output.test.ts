import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createLaqu, type LaquEvent } from "../src/index.js";

class MemoryStream extends EventEmitter {
  readonly chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

for (const format of ["human", "json", "ndjson"] as const) {
  test(`${format}: an immediately writable sink preserves 5,000 synchronous task lifecycles`, async () => {
    const stream = new MemoryStream();
    const runtime = createLaqu({ statusStream: stream, format, env: {} });
    for (let index = 0; index < 5_000; index++) runtime.createTask(`item-${index}`).succeed();
    await runtime.close();
    const text = stream.chunks.join("");
    if (format === "human") {
      strictEqual(text.trim().split("\n").length, 10_000);
      strictEqual(text.includes("item-4999"), true);
    } else {
      const events = (
        format === "json"
          ? JSON.parse(text)
          : text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
      ) as LaquEvent[];
      const tasks = events.filter((event) => event.type === "task");
      strictEqual(tasks.length, 10_000);
      for (let index = 0; index < 5_000; index++) {
        deepStrictEqual(
          tasks
            .slice(index * 2, index * 2 + 2)
            .map((event) => [event.task.title, event.task.status]),
          [
            [`item-${index}`, "running"],
            [`item-${index}`, "succeeded"],
          ],
        );
      }
      strictEqual(events.at(-1)?.type, "summary");
    }
    for (const event of ["drain", "error", "close", "finish"])
      strictEqual(stream.listenerCount(event), 0);
  });
}

test("blocked synchronous bursts still fail at the pending-record bound", async () => {
  class BlockedStream extends MemoryStream {
    override write(chunk: string): boolean {
      super.write(chunk);
      return false;
    }
  }
  const stream = new BlockedStream();
  const runtime = createLaqu({ statusStream: stream, format: "ndjson", env: {} });
  for (let index = 0; index < 2_100; index++) runtime.createTask("blocked").succeed();
  await rejects(runtime.close(), { code: "LAQU_OUTPUT_BUFFER_OVERFLOW" });
  for (const event of ["drain", "error", "close", "finish"])
    strictEqual(stream.listenerCount(event), 0);
});
