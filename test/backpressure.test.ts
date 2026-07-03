import { strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { logEvent } from "../src/events.js";
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

class UnsupportedBackpressureStream implements StreamTarget {
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

class MissingOffBackpressureStream implements StreamTarget {
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

  on(): unknown {
    throw new Error("drain listener should not be registered without off");
  }
}

class HangingBackpressureStream extends EventEmitter implements StreamTarget {
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

const jsonRenderer: Renderer = {
  render(snapshot: RuntimeSnapshot) {
    return { kind: "json", events: [logEvent(`event-${snapshot.createdAt}`, snapshot.createdAt)] };
  },
};

test("backpressure keeps only latest pending frame", async () => {
  const stream = new BackpressureStream();
  const coordinator = new OutputCoordinator(stream, renderer, false);

  coordinator.render(snapshot(1));
  coordinator.render(snapshot(2));
  coordinator.render(snapshot(3));
  stream.emit("drain");
  await coordinator.flush();

  strictEqual(stream.chunks.join("").includes("snapshot-2"), false);
  strictEqual(stream.chunks.join("").includes("snapshot-3"), true);
});

test("backpressure collapses burst frames while waiting for drain", async () => {
  const stream = new BackpressureStream();
  const coordinator = new OutputCoordinator(stream, renderer, false);

  coordinator.render(snapshot(1));
  for (let createdAt = 2; createdAt <= 1000; createdAt += 1) {
    coordinator.render(snapshot(createdAt));
  }

  strictEqual(stream.chunks.length, 1);
  stream.emit("drain");
  await coordinator.flush();

  const output = stream.chunks.join("");
  strictEqual(output.includes("snapshot-999"), false);
  strictEqual(output.includes("snapshot-1000"), true);
});

test("unsupported custom backpressure stream does not block flush", async () => {
  const stream = new UnsupportedBackpressureStream();
  const coordinator = new OutputCoordinator(stream, renderer, false);

  coordinator.render(snapshot(1));
  coordinator.render(snapshot(2));
  await coordinator.flush();

  const output = stream.chunks.join("");
  strictEqual(output.includes("snapshot-1"), true);
  strictEqual(output.includes("snapshot-2"), true);
});

test("drain listener is not registered when cleanup is unavailable", async () => {
  const stream = new MissingOffBackpressureStream();
  const coordinator = new OutputCoordinator(stream, renderer, false);

  coordinator.render(snapshot(1));
  coordinator.render(snapshot(2));
  await coordinator.flush();

  const output = stream.chunks.join("");
  strictEqual(output.includes("snapshot-1"), true);
  strictEqual(output.includes("snapshot-2"), true);
});

test("backpressure timeout keeps flush from waiting forever", async () => {
  const stream = new HangingBackpressureStream();
  const coordinator = new OutputCoordinator(stream, renderer, false, "none", 1);

  coordinator.render(snapshot(1));
  coordinator.render(snapshot(2));
  await coordinator.flush();

  const output = stream.chunks.join("");
  strictEqual(output.includes("snapshot-1"), true);
  strictEqual(output.includes("snapshot-2"), false);
});

test("backpressure preserves pending JSON events instead of replacing them", async () => {
  const stream = new BackpressureStream();
  const coordinator = new OutputCoordinator(stream, jsonRenderer, false, "ndjson");

  coordinator.render(snapshot(1));
  coordinator.render(snapshot(2));
  coordinator.render(snapshot(3));
  stream.emit("drain");
  await coordinator.flush();

  const output = stream.chunks.join("");
  strictEqual(output.includes("event-1"), true);
  strictEqual(output.includes("event-2"), true);
  strictEqual(output.includes("event-3"), true);
});

function snapshot(createdAt: number): RuntimeSnapshot {
  return {
    tasks: [],
    logs: [],
    summary: {
      total: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    createdAt,
  };
}
