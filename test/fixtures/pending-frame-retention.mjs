import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";

import { logEvent } from "../../dist-test/src/events.js";
import { OutputCoordinator } from "../../dist-test/src/output-coordinator.js";

const json = process.argv[2] === "json";
class SlowStream extends EventEmitter {
  writes = 0;
  write(chunk) {
    const sequence = Number(json ? JSON.parse(chunk).message : chunk.trim());
    assert.equal(sequence, this.writes);
    this.writes += 1;
    return false;
  }
}
const stream = new SlowStream();
const coordinator = new OutputCoordinator(
  stream,
  { render: () => ({ kind: "none" }) },
  false,
  json ? "ndjson" : "none",
  5_000,
);
const references = [];
function enqueue(sequence) {
  const frame = json
    ? { kind: "json", events: [logEvent(String(sequence), sequence)] }
    : { kind: "plain", lines: [String(sequence)] };
  // Also track a frame consumed after the latest compaction, checking prompt release.
  if ((sequence >= 1 && sequence < 2_048) || sequence === 4_500)
    references.push(new WeakRef(frame));
  coordinator.writeFrame(frame);
}
enqueue(0);
enqueue(1);
enqueue(2);
const flushing = coordinator.flush();
let maxPendingFrames = 2;
for (let sequence = 3; sequence < 5_003; sequence += 1) {
  enqueue(sequence);
  maxPendingFrames = Math.max(maxPendingFrames, sequence + 1 - stream.writes);
  stream.emit("drain");
  await setImmediate();
}
// Collect while the queue is still nonempty, outside the WeakRef creation jobs.
assert.equal(5_003 - stream.writes, 2);
await setImmediate();
global.gc();
await setImmediate();
global.gc();
const collectedFrames = references.filter((reference) => reference.deref() === undefined).length;
while (stream.writes < 5_003) {
  stream.emit("drain");
  await setImmediate();
}
stream.emit("drain");
await flushing;
await coordinator.close();
for (const event of ["error", "close", "finish", "drain"]) {
  assert.equal(stream.listenerCount(event), 0);
}
console.log(JSON.stringify({ collectedFrames, maxPendingFrames, writes: stream.writes }));
