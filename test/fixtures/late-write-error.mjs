import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { OutputCoordinator } from "../../dist-test/src/output-coordinator.js";

const mode = process.argv[2] ?? "late";
const live = mode === "cleanup";
let complete;
const stream = new Writable({
  autoDestroy: mode !== "late-no-destroy",
  write(_chunk, _encoding, callback) {
    complete = callback;
  },
});
if (mode === "eventless") {
  // A custom Writable may invoke callbacks without emitting a matching event.
  stream.write = (_chunk, callback) => {
    complete = callback;
    return true;
  };
}
const coordinator = new OutputCoordinator(
  stream,
  {
    render() {
      return live
        ? { kind: "live", lines: ["progress"], scrollbackLines: [] }
        : { kind: "plain", lines: ["progress"] };
    },
  },
  live,
  "none",
  5,
);
coordinator.render({
  tasks: [],
  logs: [],
  createdAt: 0,
  summary: { total: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0 },
});
const timeout = { code: "LAQU_OUTPUT_WRITE_TIMEOUT" };
await assert.rejects(coordinator.close(), timeout);
assert.equal(stream.listenerCount("error"), 0);

const failure = new Error("late write failure");
const received = [];
if (mode === "caller") stream.on("error", (error) => received.push(error));
if (mode === "cleanup") {
  // Complete the timed-out frame, then fail its buffered cursor cleanup write.
  complete();
  await setImmediate();
}
complete(mode === "success" ? undefined : failure);
if (mode === "unrelated-during") stream.emit("error", new Error("unrelated caller error"));
await setImmediate();
assert.equal(stream.listenerCount("error"), mode === "caller" ? 1 : 0);
assert.deepEqual(received, mode === "caller" ? [failure] : []);
await assert.rejects(coordinator.flush(), timeout);
if (mode === "unrelated") stream.emit("error", new Error("unrelated caller error"));
process.stdout.write(`${JSON.stringify({ survived: true, mode })}\n`);
