import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createLaqu } from "../dist/index.js";
import { TaskStore } from "../dist/task-store.js";

const taskCount = 3_000;

if (process.argv[2] === "--sample") {
  const policy = process.argv[3];
  assert.ok(policy === "silent" || policy === "never");
  const warmup = createLaqu({ progressPolicy: policy, checkForUpdates: false });
  for (let index = 0; index < 20; index += 1) await warmup.task("warmup", () => index);
  await warmup.close();

  let snapshots = 0;
  let flatTaskSnapshots = 0;
  let writes = 0;
  const originalSnapshot = TaskStore.prototype.snapshot;
  // Count root snapshots in this flat workload without traversing the returned tree.
  TaskStore.prototype.snapshot = function () {
    const result = originalSnapshot.call(this);
    snapshots += 1;
    flatTaskSnapshots += result.tasks.length;
    return result;
  };
  const runtime = createLaqu({
    statusStream: {
      write() {
        writes += 1;
        return true;
      },
    },
    progressPolicy: policy,
    checkForUpdates: false,
  });
  let sum = 0;
  const start = performance.now();
  try {
    for (let index = 0; index < taskCount; index += 1) {
      sum += await runtime.task("work", () => index);
    }
    await runtime.close();
  } finally {
    TaskStore.prototype.snapshot = originalSnapshot;
  }
  const milliseconds = performance.now() - start;
  assert.equal(sum, (taskCount * (taskCount - 1)) / 2);
  assert.equal(writes, 0);
  console.log(JSON.stringify({ milliseconds, snapshots, flatTaskSnapshots, writes, sum }));
} else {
  for (const policy of ["silent", "never"]) {
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--sample", policy],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(child.status, 0, child.stderr);
      samples.push(JSON.parse(child.stdout));
    }
    const medianMilliseconds = samples
      .map((sample) => sample.milliseconds)
      .sort((a, b) => a - b)[1];
    console.log(
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        policy,
        taskCount,
        retainedTerminalLimit: 1_000,
        samples,
        medianMilliseconds,
      }),
    );
  }
}
