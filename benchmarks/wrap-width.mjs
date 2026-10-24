import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { displayWidth, wrapToColumns } from "../dist/width.js";

const columns = 80;
const repetitions = 150_000;

if (process.argv.includes("--sample")) {
  wrapToColumns("warmup 👩‍💻".repeat(10), columns);
  const input = "👩‍💻e\u0301".repeat(repetitions);
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  const lines = wrapToColumns(input, columns);
  const milliseconds = performance.now() - start;
  const peakRss = process.resourceUsage().maxRSS * 1024;
  // Validate after recording memory so verification allocations are excluded.
  const hash = createHash("sha256");
  for (const line of lines) {
    assert.ok(displayWidth(line) <= columns);
    hash.update(line).update("\n");
  }
  assert.equal(lines.join(""), input);
  console.log(
    JSON.stringify({
      milliseconds,
      rssBefore,
      peakRss,
      lineCount: lines.length,
      outputHash: hash.digest("hex"),
    }),
  );
} else {
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", fileURLToPath(import.meta.url), "--sample"],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    samples.push(JSON.parse(child.stdout));
  }
  assert.equal(new Set(samples.map((sample) => sample.outputHash)).size, 1);
  const median = (key) => samples.map((sample) => sample[key]).sort((a, b) => a - b)[1];
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      columns,
      graphemeCount: repetitions * 2,
      samples,
      medianMilliseconds: median("milliseconds"),
      medianPeakRss: median("peakRss"),
    }),
  );
}
