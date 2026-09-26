import { Writable } from "node:stream";
import { performance } from "node:perf_hooks";

import { createLaqu } from "../dist/index.js";
import { AnsiLiveRenderer } from "../dist/renderer.js";
import { TaskStore, setCompletedProgress } from "../dist/task-store.js";
import { compileTheme } from "../dist/theme.js";

const sizes = [10, 1_000, 10_000];
const samplesPerSize = 3;
const columns = 80;
const maxRows = 10;
const theme = compileTheme({ useColor: false });

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function collectHeap() {
  global.gc?.();
  return process.memoryUsage().heapUsed;
}

function measureTaskSet(taskCount) {
  const beforeHeap = collectHeap();
  const store = new TaskStore();
  const ids = [];
  const createStart = performance.now();
  for (let index = 0; index < taskCount; index += 1) {
    const title = index % 10 === 0 ? "한글👩🏽‍💻é".repeat(12) : `task-${index}`;
    ids.push(store.createTask(title, { total: 100, completed: index % 100 }));
  }
  const createMs = round(performance.now() - createStart);
  const retainedHeapBytes = collectHeap() - beforeHeap;

  const snapshotStart = performance.now();
  const snapshot = store.snapshot();
  const snapshotMs = round(performance.now() - snapshotStart);
  const renderStart = performance.now();
  const frame = new AnsiLiveRenderer(theme, columns, maxRows).render(snapshot);
  const renderMs = round(performance.now() - renderStart);
  if (frame.kind !== "live") throw new Error("Expected a live frame");

  const updateCount = Math.min(taskCount, 1_000);
  const updateStart = performance.now();
  for (let index = 0; index < updateCount; index += 1) {
    const id = ids[index];
    store.update(id, { progress: setCompletedProgress(50, store.getProgress(id)) });
  }
  const updateMs = round(performance.now() - updateStart);
  const resnapshotStart = performance.now();
  store.snapshot();
  const resnapshotMs = round(performance.now() - resnapshotStart);

  return {
    createMs,
    retainedHeapBytes,
    snapshotMs,
    renderMs,
    frameBytes: Buffer.byteLength(frame.lines.join("\n")),
    updateCount,
    updateMs,
    resnapshotMs,
  };
}

function measureDeepTree() {
  const store = new TaskStore();
  let parentId;
  for (let depth = 0; depth < 1_000; depth += 1) {
    parentId = store.createTask(`depth-${depth}`, { total: 1 }, parentId);
  }
  const start = performance.now();
  const snapshot = store.snapshot();
  const snapshotMs = round(performance.now() - start);
  const renderStart = performance.now();
  const frame = new AnsiLiveRenderer(theme, columns, maxRows).render(snapshot);
  if (frame.kind !== "live") throw new Error("Expected a live frame");
  return {
    depth: 1_000,
    snapshotMs,
    renderMs: round(performance.now() - renderStart),
    frameBytes: Buffer.byteLength(frame.lines.join("\n")),
  };
}

async function measureSlowStream() {
  let writtenBytes = 0;
  let peakWritableBytes = 0;
  const statusStream = new Writable({
    highWaterMark: 128,
    write(chunk, _encoding, callback) {
      peakWritableBytes = Math.max(peakWritableBytes, statusStream.writableLength);
      setTimeout(() => {
        writtenBytes += chunk.length;
        callback();
      }, 2);
    },
  });
  const runtime = createLaqu({
    statusStream,
    format: "ndjson",
    streamCapability: "pipe",
    env: {},
  });
  const start = performance.now();
  for (let index = 0; index < 50; index += 1) {
    runtime.createTask(`slow-${index}`, { total: 1, completed: 1 }).succeed();
  }
  await runtime.close();
  const flushMs = round(performance.now() - start);
  statusStream.destroy();
  return { taskCount: 50, writeDelayMs: 2, flushMs, writtenBytes, peakWritableBytes };
}

measureTaskSet(10);
const taskSets = sizes.map((taskCount) => ({
  taskCount,
  samples: Array.from({ length: samplesPerSize }, () => measureTaskSet(taskCount)),
}));
const report = {
  schemaVersion: 1,
  nodeVersion: process.versions.node,
  platform: process.platform,
  architecture: process.arch,
  conditions: { columns, maxRows, samplesPerSize, forcedGc: typeof global.gc === "function" },
  taskSets,
  deepTree: measureDeepTree(),
  slowStream: await measureSlowStream(),
};
process.stdout.write(`${JSON.stringify(report)}\n`);
