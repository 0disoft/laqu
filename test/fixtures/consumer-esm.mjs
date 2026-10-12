import assert from "node:assert/strict";

import { createLaqu, LaquOutputError } from "@0disoft/laqu";
import { LAQU_EVENT_SCHEMA_VERSION } from "@0disoft/laqu/events";
import { compileTheme } from "@0disoft/laqu/theme";
import { displayWidth } from "@0disoft/laqu/width";

if (typeof createLaqu !== "function") {
  throw new TypeError("createLaqu export is not callable");
}

if (new LaquOutputError("LAQU_OUTPUT_WRITE_FAILED", "probe").code !== "LAQU_OUTPUT_WRITE_FAILED") {
  throw new Error("LaquOutputError export is not functional");
}

if (LAQU_EVENT_SCHEMA_VERSION !== 1) {
  throw new Error("unexpected laqu event schema version");
}

if (displayWidth("한") !== 2) {
  throw new Error("width subpath export is not functional");
}

if (compileTheme({ useColor: false }).tokens.successSymbol.length === 0) {
  throw new Error("theme subpath export is not functional");
}

const chunks = [];
const stderr = {
  write(chunk) {
    chunks.push(chunk);
    return true;
  },
};
const runtime = createLaqu({
  stderr,
  env: {},
  format: "ndjson",
  retention: { maxTerminalTasks: 0 },
});
const original = new Error("consumer failure after manual success");
try {
  await assert.rejects(
    runtime.task("late consumer failure", async (task) => {
      task.succeed();
      await runtime.flush();
      await runtime.flush();
      throw original;
    }),
    (error) => error === original,
  );
  let reads = 0;
  const getterError = new Error();
  Object.defineProperty(getterError, "message", {
    get: () => (++reads === 1 ? "consumer getter failure" : {}),
  });
  await assert.rejects(
    runtime.task("getter consumer failure", () => {
      throw getterError;
    }),
    (error) => error === getterError,
  );
  assert.equal(reads, 1);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  let rejected = false;
  await runtime
    .task("proxy consumer failure", () => {
      throw revoked.proxy;
    })
    .then(
      () => {},
      (error) => {
        rejected = true;
        assert.equal(error, revoked.proxy);
      },
    );
  assert.equal(rejected, true);
  assert.equal(await runtime.task("next consumer task", () => 42), 42);
} finally {
  await runtime.close();
}
const events = chunks
  .join("")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const terminal = events
  .filter((event) => event.type === "task" && event.task.title === "late consumer failure")
  .at(-1);
assert.equal(terminal.task.status, "failed");
assert.equal(terminal.task.message, original.message);
assert.deepEqual(events.find((event) => event.type === "summary").tasks, {
  total: 4,
  running: 0,
  succeeded: 1,
  failed: 3,
  cancelled: 0,
  skipped: 0,
});
await createLaqu({ stderr, env: {}, progressPolicy: "silent" }).close();
