import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { AnsiLiveRenderer, JsonEventRenderer, PlainLogRenderer } from "../src/renderer.js";
import { compileTheme } from "../src/theme.js";
import type {
  AggregateProgress,
  ProgressState,
  RuntimeSnapshot,
  TaskSnapshot,
} from "../src/task-store.js";
import { displayWidth } from "../src/width.js";

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

test("live renderer emits new logs as scrollback above the live frame", () => {
  const renderer = new AnsiLiveRenderer(theme, 80, 10);
  const first = renderer.render(snapshot([task("task-1", "running")], 1, ["first log"]));
  const second = renderer.render(
    snapshot([task("task-1", "running")], 2, ["first log", "second log"]),
  );

  strictEqual(first.kind, "live");
  if (first.kind === "live") {
    deepStrictEqual(first.scrollbackLines, ["first log"]);
    strictEqual(
      first.lines.some((line) => line.includes("running")),
      true,
    );
  }
  strictEqual(second.kind, "live");
  if (second.kind === "live") {
    deepStrictEqual(second.scrollbackLines, ["second log"]);
  }
});

test("live renderer prioritizes active tasks within the exact row budget", () => {
  const renderer = new AnsiLiveRenderer(theme, 80, 2);
  const doneOne = { ...task("task-1", "done-one"), status: "succeeded" as const };
  const doneTwo = { ...task("task-2", "done-two"), status: "succeeded" as const };
  const active = task("task-3", "active-now");
  const frame = renderer.render(snapshot([doneOne, doneTwo, active], 1));

  strictEqual(frame.kind, "live");
  if (frame.kind === "live") {
    strictEqual(frame.lines.length, 2);
    strictEqual(frame.lines[0]?.includes("active-now"), true);
    strictEqual(frame.lines[1]?.includes("2 more tasks"), true);
    strictEqual(
      frame.lines.some((line) => line.includes("done-one")),
      false,
    );
  }
});

test("single-row live rendering keeps the highest-priority task visible", () => {
  const renderer = new AnsiLiveRenderer(theme, 80, 1);
  const done = { ...task("task-1", "done"), status: "succeeded" as const };
  const active = task("task-2", "active-now");
  const frame = renderer.render(snapshot([done, active], 1));

  strictEqual(frame.kind, "live");
  if (frame.kind === "live") {
    strictEqual(frame.lines.length, 1);
    strictEqual(frame.lines[0]?.includes("active-now"), true);
  }
});

test("live renderer reads current terminal geometry for every frame", () => {
  let columns = 40;
  let maxRows = 3;
  const renderer = new AnsiLiveRenderer(
    theme,
    () => columns,
    () => maxRows,
  );
  const tasks = [task("task-1", "a-long-running-task"), task("task-2", "second-active-task")];

  const wide = renderer.render(snapshot(tasks, 1));
  columns = 12;
  maxRows = 1;
  const resized = renderer.render(snapshot(tasks, 2));

  strictEqual(wide.kind, "live");
  strictEqual(resized.kind, "live");
  if (resized.kind === "live") {
    strictEqual(resized.lines.length, 1);
    strictEqual(
      resized.lines.every((line) => displayWidth(line) <= 12),
      true,
    );
  }
});

test("renderer log cursors survive retained log windows", () => {
  const renderer = new PlainLogRenderer(theme, 80, 10);

  const first = renderer.render(snapshotWithLogs([log("one", 1), log("two", 2)]));
  const second = renderer.render(snapshotWithLogs([log("three", 3)]));

  strictEqual(first.kind, "plain");
  strictEqual(second.kind, "plain");
  if (second.kind === "plain") {
    deepStrictEqual(second.lines, ["three"]);
  }
});

test("json event renderer emits summary only during finalize", () => {
  const renderer = new JsonEventRenderer();
  const done = { ...task("task-1", "done"), status: "succeeded" as const, updatedAt: 1 };
  const first = renderer.render(snapshot([done], 1));
  const afterLog = renderer.render(snapshot([done], 2, ["late log"]));
  const final = renderer.finalize(snapshot([done], 3, ["late log"]));

  strictEqual(first.kind, "json");
  if (first.kind === "json") {
    const summaryEvents = first.events.filter((event) => event.type === "summary");
    strictEqual(summaryEvents.length, 0);
  }
  strictEqual(afterLog.kind, "json");
  if (afterLog.kind === "json") {
    const summaryEvents = afterLog.events.filter((event) => event.type === "summary");
    const logEvents = afterLog.events.filter((event) => event.type === "log");
    strictEqual(summaryEvents.length, 0);
    strictEqual(logEvents.length, 1);
  }
  strictEqual(final.kind, "json");
  if (final.kind === "json") {
    const summaryEvents = final.events.filter((event) => event.type === "summary");
    strictEqual(summaryEvents.length, 1);
  }
});

test("json event renderer summarizes pruned tasks from snapshot summary", () => {
  const renderer = new JsonEventRenderer();
  const final = renderer.finalize({
    tasks: [],
    logs: [],
    summary: {
      total: 3,
      running: 0,
      succeeded: 2,
      failed: 1,
      cancelled: 0,
      skipped: 0,
    },
    createdAt: 4,
  });

  strictEqual(final.kind, "json");
  if (final.kind === "json") {
    const summary = final.events.find((event) => event.type === "summary");
    strictEqual(summary?.type, "summary");
    if (summary?.type === "summary") {
      deepStrictEqual(summary.tasks, {
        total: 3,
        running: 0,
        succeeded: 2,
        failed: 1,
        cancelled: 0,
        skipped: 0,
      });
    }
  }
});

test("plain renderer strips terminal controls from ordinary text", () => {
  const renderer = new PlainLogRenderer(theme, 80, 10);
  const unsafe = "\u001b[31mred\u001b[0m\rspoof";
  const rendered = renderer.render(snapshot([task("task-1", unsafe)], 1, [unsafe]));

  strictEqual(rendered.kind, "plain");
  if (rendered.kind === "plain") {
    strictEqual(
      rendered.lines.some((line) => line.includes("\u001b")),
      false,
    );
    strictEqual(
      rendered.lines.some((line) => line.includes("\r")),
      false,
    );
    strictEqual(
      rendered.lines.some((line) => line.includes("red spoof")),
      true,
    );
  }
});

function snapshot(
  tasks: readonly TaskSnapshot[],
  createdAt: number,
  logs: readonly string[] = [],
): RuntimeSnapshot {
  return {
    tasks,
    logs: logs.map((message, index) => ({
      message,
      createdAt: createdAt + index,
      sequence: index + 1,
    })),
    summary: summarizeTasks(tasks),
    createdAt,
  };
}

function snapshotWithLogs(
  logs: readonly { readonly message: string; readonly sequence: number }[],
): RuntimeSnapshot {
  return {
    tasks: [],
    logs: logs.map((item) => ({
      message: item.message,
      createdAt: item.sequence,
      sequence: item.sequence,
    })),
    summary: summarizeTasks([]),
    createdAt: logs.at(-1)?.sequence ?? 0,
  };
}

function log(
  message: string,
  sequence: number,
): { readonly message: string; readonly sequence: number } {
  return { message, sequence };
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

function summarizeTasks(tasks: readonly TaskSnapshot[]): RuntimeSnapshot["summary"] {
  const summary = {
    total: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  const stack = [...tasks].reverse();
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      continue;
    }
    summary.total += 1;
    switch (item.status) {
      case "running":
        summary.running += 1;
        break;
      case "succeeded":
        summary.succeeded += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "pending":
        break;
    }
    for (let index = item.children.length - 1; index >= 0; index -= 1) {
      const child = item.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return summary;
}
