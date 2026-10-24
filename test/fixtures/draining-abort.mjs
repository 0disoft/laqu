import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";

import { createLaqu } from "../../dist-test/src/index.js";

const chunks = [];
const runtime = createLaqu({
  statusStream: {
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
  },
  streamCapability: "pipe",
  format: "ndjson",
  checkForUpdates: false,
});
const controller = new AbortController();
const manual =
  process.argv[2] === "child"
    ? runtime.createTask("parent").child("manual", { signal: controller.signal })
    : runtime.createTask("manual", { signal: controller.signal });
let release;
const scoped = runtime.task(
  "slow",
  () =>
    new Promise((resolve) => {
      release = resolve;
    }),
);
const closing = runtime.close();
assert.throws(() => manual.setMessage("forbidden caller mutation"), /runtime is closing/);
controller.abort();
await setImmediate();
assert.equal(getEventListeners(controller.signal, "abort").length, 0);
release(42);
assert.equal(await scoped, 42);
await closing;
const events = chunks
  .join("")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const last = events.filter((event) => event.type === "task" && event.task.id === manual.id).at(-1);
assert.equal(last.task.status, "cancelled");
assert.equal(last.task.message, "aborted");
assert.equal(events.find((event) => event.type === "summary").tasks.running, 0);
process.stdout.write(JSON.stringify({ cancelled: true }));
