import { strictEqual, throws } from "node:assert";
import test from "node:test";

import { createLaqu } from "../src/index.js";
import type { StreamTarget } from "../src/types.js";

class FakeStream implements StreamTarget {
  readonly chunks: string[] = [];
  isTTY = false;
  columns = 80;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

class ThrowingStream implements StreamTarget {
  isTTY = false;
  columns = 80;

  write(): boolean {
    throw new Error("EPIPE synthetic");
  }
}

test("runtime rejects invalid public option enums", () => {
  throws(() => createLaqu({ stderr: new FakeStream(), env: {}, format: "xml" as never }), {
    name: "TypeError",
    message: "format must be one of: human, json, ndjson",
  });
  throws(
    () =>
      createLaqu({
        stderr: new FakeStream(),
        env: {},
        progressPolicy: "stream-everything" as never,
      }),
    {
      name: "TypeError",
      message: "progressPolicy must be one of: auto, always, never, plain, jsonl, silent",
    },
  );
  throws(
    () => createLaqu({ stderr: new FakeStream(), env: {}, streamCapability: "printer" as never }),
    {
      name: "TypeError",
      message: "streamCapability must be one of: tty, ci, pipe, dumb",
    },
  );
});

test("automatic flush does not leak unhandled rejections when status writes fail", async () => {
  const runtime = createLaqu({ stderr: new ThrowingStream(), env: {}, streamCapability: "pipe" });
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.once("unhandledRejection", onUnhandled);

  runtime.log("write failure should not kill the process");
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", onUnhandled);
  await runtime.close();

  strictEqual(unhandled, undefined);
});
