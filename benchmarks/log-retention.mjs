import { performance } from "node:perf_hooks";

import { TaskStore } from "../dist/task-store.js";

const appended = 10_000;
const samplesPerSize = 3;

for (const retained of [1_000, 10_000]) {
  const samples = [];
  for (let sample = 0; sample < samplesPerSize; sample += 1) {
    const store = new TaskStore({ maxLogs: retained });
    for (let index = 0; index < retained; index += 1) store.addLog("warmup");
    const start = performance.now();
    for (let index = 0; index < appended; index += 1) store.addLog("message");
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  console.log(
    JSON.stringify({
      retained,
      appended,
      medianMs: Number(samples[1].toFixed(3)),
      samplesMs: samples.map((ms) => Number(ms.toFixed(3))),
    }),
  );
}
