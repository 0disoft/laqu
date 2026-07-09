import { strictEqual, throws } from "node:assert";
import test from "node:test";

import { createLaqu } from "../src/index.js";
import { OutputCoordinator } from "../src/output-coordinator.js";
import type { Renderer } from "../src/renderer.js";
import type { StreamTarget } from "../src/types.js";

type Listener = (...args: readonly unknown[]) => void;

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

class BackpressureThenThrowStream implements StreamTarget {
  readonly chunks: string[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  isTTY = false;
  columns = 80;
  #writes = 0;

  write(chunk: string): boolean {
    this.#writes += 1;
    this.chunks.push(chunk);
    if (this.#writes === 1) {
      return false;
    }
    throw new Error("EPIPE synthetic");
  }

  on(event: "drain" | "error" | "close" | "finish", listener: Listener): unknown {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: "drain" | "error" | "close" | "finish", listener: Listener): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: "drain" | "error" | "close" | "finish"): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  listenerCount(event: "drain" | "error" | "close" | "finish"): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const nullRenderer: Renderer = {
  render: () => ({ kind: "none" }),
};

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

test("pending drain listeners are cleaned up when replayed output write fails", async () => {
  const stream = new BackpressureThenThrowStream();
  const output = new OutputCoordinator(stream, nullRenderer, false);

  output.writeFrame({ kind: "plain", lines: ["first"] });
  output.writeFrame({ kind: "plain", lines: ["second"] });

  const flush = output.flush();
  stream.emit("drain");
  await flush;

  strictEqual(stream.listenerCount("drain"), 0);
  strictEqual(stream.listenerCount("error"), 0);
  strictEqual(stream.listenerCount("close"), 0);
  strictEqual(stream.listenerCount("finish"), 0);
  strictEqual(stream.chunks.length, 2);
  await output.close();
});
