import { performance } from "node:perf_hooks";

import { truncateToColumns } from "../dist/width.js";

const columns = 80;
const calls = 10;
const options = { overflowMarker: "…" };

for (const size of [10_000, 100_000]) {
  const input = "x".repeat(size);
  for (let warmup = 0; warmup < 2; warmup += 1) truncateToColumns(input, columns, options);
  const samples = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const start = performance.now();
    for (let call = 0; call < calls; call += 1) truncateToColumns(input, columns, options);
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      size,
      columns,
      calls,
      medianMs: Number(samples[1].toFixed(3)),
      samplesMs: samples.map((ms) => Number(ms.toFixed(3))),
    }),
  );
}
