import { strictEqual } from "node:assert";
import test from "node:test";

import { JsonEventRenderer, PlainLogRenderer } from "../src/renderer.js";
import { compileTheme } from "../src/theme.js";
import type {
  AggregateProgress,
  ProgressState,
  RuntimeSnapshot,
  TaskSnapshot,
} from "../src/task-store.js";

const theme = compileTheme({ useColor: false });
const noneProgress: ProgressState = { kind: "none" };
const noneAggregate: AggregateProgress = { kind: "none" };

test("plain renderer prunes task states after tasks leave the snapshot", () => {
  const renderer = new PlainLogRenderer(theme, 80, 10);
  const first = snapshot([task("task-1", "repeatable")], 1);
  const empty = snapshot([], 2);
  const repeated = snapshot([task("task-1", "repeatable")], 3);

  strictEqual(renderer.render(first).kind, "plain");
  strictEqual(renderer.render(first).kind, "none");
  strictEqual(renderer.render(empty).kind, "none");
  strictEqual(renderer.render(repeated).kind, "plain");
});

test("json event renderer prunes task states after tasks leave the snapshot", () => {
  const renderer = new JsonEventRenderer();
  const first = snapshot([task("task-1", "repeatable")], 1);
  const empty = snapshot([], 2);
  const repeated = snapshot([task("task-1", "repeatable")], 3);

  strictEqual(renderer.render(first).kind, "json");
  strictEqual(renderer.render(first).kind, "none");
  strictEqual(renderer.render(empty).kind, "none");
  strictEqual(renderer.render(repeated).kind, "json");
});

function snapshot(tasks: readonly TaskSnapshot[], createdAt: number): RuntimeSnapshot {
  return { tasks, logs: [], createdAt };
}

function task(id: string, title: string): TaskSnapshot {
  return {
    id,
    parentId: undefined,
    title,
    status: "running",
    progress: noneProgress,
    aggregate: noneAggregate,
    message: undefined,
    detail: undefined,
    weight: 1,
    depth: 0,
    children: [],
    updatedAt: 1,
  };
}
