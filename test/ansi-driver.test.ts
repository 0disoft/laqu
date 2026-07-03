import { ok, strictEqual } from "node:assert";
import test from "node:test";

import { OutputCoordinator } from "../src/output-coordinator.js";
import type { Renderer } from "../src/renderer.js";
import type { RuntimeSnapshot } from "../src/task-store.js";
import type { StreamTarget } from "../src/types.js";

class FakeStream implements StreamTarget {
  readonly chunks: string[] = [];
  isTTY = true;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

const renderer: Renderer = {
  render(snapshot: RuntimeSnapshot) {
    return { kind: "live", lines: [`frame-${snapshot.createdAt}`] };
  },
};

test("live renderer erases previous virtual screen before redraw", async () => {
  const stream = new FakeStream();
  const coordinator = new OutputCoordinator(stream, renderer, true);

  coordinator.render({ tasks: [], logs: [], createdAt: 1 });
  coordinator.render({ tasks: [], logs: [], createdAt: 2 });
  await coordinator.close();

  const output = stream.chunks.join("");
  ok(output.includes("\u001b[2K"));
  ok(output.includes("\u001b[?25l"));
  ok(output.includes("\u001b[?25h"));
  strictEqual(coordinator.lease.closed, true);
});

test("cleanup is idempotent", async () => {
  const stream = new FakeStream();
  const coordinator = new OutputCoordinator(stream, renderer, true);

  coordinator.render({ tasks: [], logs: [], createdAt: 1 });
  await coordinator.close();
  await coordinator.close();

  strictEqual(coordinator.lease.closed, true);
});

test("identical live frame is not written twice", async () => {
  const stream = new FakeStream();
  const coordinator = new OutputCoordinator(
    stream,
    {
      render() {
        return { kind: "live", lines: ["same"] };
      },
    },
    true,
  );

  coordinator.render({ tasks: [], logs: [], createdAt: 1 });
  const writesAfterFirstRender = stream.chunks.length;
  coordinator.render({ tasks: [], logs: [], createdAt: 2 });
  await coordinator.close();

  strictEqual(writesAfterFirstRender, 1);
});
