import { rejects, strictEqual } from "node:assert";
import test from "node:test";

import type { LaquEvent, LaquTaskEvent } from "../src/events.js";
import { createLaqu } from "../src/index.js";
import { unknownToRejectionError } from "../src/runtime.js";

function fixture() {
  const chunks: string[] = [];
  const runtime = createLaqu({
    stderr: {
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
    },
    env: {},
    format: "json",
  });
  return { runtime, events: () => JSON.parse(chunks.join("")) as LaquEvent[] };
}

test("an Error message is read once without replacing the callback's original rejection", async () => {
  const { runtime, events } = fixture();
  let reads = 0;
  const original = new Error();
  Object.defineProperty(original, "message", { get: () => (++reads === 1 ? "first message" : {}) });
  try {
    await rejects(
      runtime.task("getter failure", () => {
        throw original;
      }),
      (error) => error === original,
    );
  } finally {
    await runtime.close();
  }
  strictEqual(reads, 1);
  const terminal = events()
    .filter((event): event is LaquTaskEvent => event.type === "task")
    .at(-1);
  strictEqual(terminal?.task.status, "failed");
  strictEqual(terminal?.task.message, "first message");
  strictEqual(events().find((event) => event.type === "summary")?.tasks.failed, 1);
});

for (const kind of ["revoked", "prototype-throws"] as const) {
  test(`${kind}: manual and scoped failures remain terminal without inspecting private content`, async () => {
    const { runtime, events } = fixture();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const original =
      kind === "revoked"
        ? revoked.proxy
        : new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error("private prototype detail");
              },
              get() {
                throw new Error("private property detail");
              },
            },
          );
    try {
      let rejected = false;
      // assert.rejects inspects the rejection's .then; revoked Proxies forbid that.
      await runtime
        .task("proxy failure", () => {
          throw original;
        })
        .then(
          () => {},
          (error: unknown) => {
            rejected = true;
            strictEqual(error, original);
          },
        );
      strictEqual(rejected, true);
      runtime.createTask("manual proxy failure").fail(original);
    } finally {
      await runtime.close();
    }
    const result = events();
    const summary = result.find((event) => event.type === "summary");
    strictEqual(summary?.tasks.failed, 2);
    strictEqual(summary?.tasks.running, 0);
    const terminal = result.filter(
      (event): event is LaquTaskEvent => event.type === "task" && event.task.status === "failed",
    );
    strictEqual(terminal.length, 2);
    strictEqual(
      terminal.every((event) => event.task.message === "Non-Error thrown"),
      true,
    );
    strictEqual(JSON.stringify(result).includes("private"), false);
    const error = unknownToRejectionError(original);
    strictEqual(error.cause, original);
    strictEqual(error.message, "Unhandled promise rejection: Non-Error thrown");
  });
}
