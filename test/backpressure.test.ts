import { strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { OutputCoordinator } from "../src/output-coordinator.js";
import type { Renderer } from "../src/renderer.js";
import type { RuntimeSnapshot } from "../src/task-store.js";
import type { StreamTarget } from "../src/types.js";

class BackpressureStream extends EventEmitter implements StreamTarget {
  readonly chunks: string[] = [];
  failNext = true;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.failNext) {
      this.failNext = false;
      return false;
    }
    return true;
  }
}

const renderer: Renderer = {
  render(snapshot: RuntimeSnapshot) {
    return { kind: "plain", lines: [`snapshot-${snapshot.createdAt}`] };
  },
};

test("backpressure keeps only latest pending frame", async () => {
  const stream = new BackpressureStream();
  const coordinator = new OutputCoordinator(stream, renderer, false);

  coordinator.render({ tasks: [], logs: [], createdAt: 1 });
  coordinator.render({ tasks: [], logs: [], createdAt: 2 });
  coordinator.render({ tasks: [], logs: [], createdAt: 3 });
  stream.emit("drain");
  await coordinator.flush();

  strictEqual(stream.chunks.join("").includes("snapshot-2"), false);
  strictEqual(stream.chunks.join("").includes("snapshot-3"), true);
});

test("backpressure collapses burst frames while waiting for drain", async () => {
  const stream = new BackpressureStream();
  const coordinator = new OutputCoordinator(stream, renderer, false);

  coordinator.render({ tasks: [], logs: [], createdAt: 1 });
  for (let createdAt = 2; createdAt <= 1000; createdAt += 1) {
    coordinator.render({ tasks: [], logs: [], createdAt });
  }

  strictEqual(stream.chunks.length, 1);
  stream.emit("drain");
  await coordinator.flush();

  const output = stream.chunks.join("");
  strictEqual(output.includes("snapshot-999"), false);
  strictEqual(output.includes("snapshot-1000"), true);
});
