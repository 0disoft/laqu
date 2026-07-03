import { strictEqual } from "node:assert";
import test from "node:test";

import { createLaqu } from "../src/index.js";
import type { StreamTarget } from "../src/types.js";

class SmokeTty implements StreamTarget {
  readonly chunks: string[] = [];
  readonly isTTY = true;
  readonly columns = 40;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

test("PTY smoke boundary stays optional and uses Node streams only", async () => {
  const stderr = new SmokeTty();
  const runtime = createLaqu({
    stderr,
    env: { TERM: "dumb" },
    streamCapability: "tty",
    manageProcessLifecycle: false,
  });

  const task = runtime.createTask("pty-smoke", { ratio: 1 });
  task.succeed();
  await runtime.close();

  strictEqual(
    stderr.chunks.some((chunk) => chunk.includes("pty-smoke")),
    true,
  );
});
