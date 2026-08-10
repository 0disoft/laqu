import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

import { createLaqu } from "../../dist-test/src/index.js";

const phaseFd = Number(process.env.LAQU_PHASE_FD);
if (!Number.isSafeInteger(phaseFd)) {
  throw new Error("LAQU_PHASE_FD must identify the harness phase pipe");
}

const runtime = createLaqu({
  stderr: process.stderr,
  env: {},
  streamCapability: "tty",
  maxRows: 4,
});
const task = runtime.createTask("pty-resize-task", { ratio: 0.5 });
await runtime.flush();
process.stderr.write("\n__LAQU_INITIAL__\n");
writeSync(phaseFd, "initial\n");

process.stderr.once("resize", () => {
  writeSync(phaseFd, "terminal-resized\n");
});

const input = createInterface({ input: process.stdin, terminal: false });
let resized = false;
for await (const line of input) {
  if (line === "close" && resized) {
    break;
  }
  if (line !== "resize" || resized) {
    continue;
  }
  resized = true;
  task.setMessage("message-after-terminal-resize");
  await runtime.flush();
  process.stderr.write("\n__LAQU_RESIZED__\n");
  writeSync(phaseFd, "resized\n");
}
input.close();

task.succeed();
await runtime.close();
writeSync(phaseFd, "closed\n");
