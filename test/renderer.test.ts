import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { AnsiLiveRenderer, JsonEventRenderer, PlainLogRenderer } from "../src/renderer.js";
import { compileTheme } from "../src/theme.js";
import { TaskStore } from "../src/task-store.js";
import type {
  AggregateProgress,
  ProgressState,
  RuntimeSnapshot,
  TaskSnapshot,
} from "../src/task-store.js";
import { displayWidth, sanitizeText, stripAnsi } from "../src/width.js";

const theme = compileTheme({ useColor: false });
const noneProgress: ProgressState = { kind: "none" };
const noneAggregate: AggregateProgress = { kind: "none" };

for (const columns of [8, 24]) {
  test(`live logs preserve the full cause and graphemes across ${columns}-column lines`, () => {
    const store = new TaskStore();
    store.createTask("active task");
    const message = `\u001b[2J${"한글".normalize("NFD")}/👩‍💻/${"nested/".repeat(8)}report.json: permission denied`;
    store.addLog(message);
    const renderer = new AnsiLiveRenderer(theme, columns, 2);
    const frame = renderer.render(store.snapshot());
    if (frame.kind !== "live") throw new Error("expected live frame");
    strictEqual(frame.scrollbackLines.length > 1, true);
    strictEqual(frame.scrollbackLines.join(""), sanitizeText(message));
    strictEqual(
      frame.scrollbackLines.every((line) => displayWidth(line) <= columns),
      true,
    );
    strictEqual(frame.lines.length <= 2, true);
    const repeated = renderer.render(store.snapshot());
    if (repeated.kind !== "live") throw new Error("expected live frame");
    deepStrictEqual(repeated.scrollbackLines, []);
  });
}

test("late failures stay visible and are recorded once in live scrollback", () => {
  const store = new TaskStore({ maxTerminalTasks: 0 });
  for (let index = 0; index < 10; index += 1) {
    store.update(store.createTask(`success-${index}`), { status: "succeeded" });
  }
  const id = store.createTask("deployment");
  store.update(id, { status: "failed", message: "permission denied /deploy" });
  const renderer = new AnsiLiveRenderer(theme, 100, 12);
  const first = renderer.render(store.snapshot());
  if (first.kind !== "live") throw new Error("expected live frame");
  strictEqual(
    first.lines.some((line) => line.includes("permission denied /deploy")),
    true,
  );
  deepStrictEqual(first.scrollbackLines, ["× deployment permission denied /deploy"]);
  const repeated = renderer.render(store.snapshot());
  if (repeated.kind !== "live") throw new Error("expected live frame");
  deepStrictEqual(repeated.scrollbackLines, []);
  const pruned = renderer.render(store.snapshot());
  if (pruned.kind !== "live") throw new Error("expected live frame");
  deepStrictEqual(pruned.scrollbackLines, []);
  strictEqual(pruned.lines.length, 0);
});

test("live failures outrank active rows and preserve all diagnostics beyond the row budget", () => {
  const store = new TaskStore();
  store.createTask("still running");
  for (let index = 0; index < 3; index += 1) {
    store.update(store.createTask(`failed-${index}`), {
      status: "failed",
      message: `permission denied ${index}`,
    });
  }
  const frame = new AnsiLiveRenderer(theme, 100, 1).render(store.snapshot());
  if (frame.kind !== "live") throw new Error("expected live frame");
  strictEqual(frame.lines.length, 1);
  strictEqual(frame.lines[0]?.includes("failed-0"), true);
  strictEqual(frame.scrollbackLines.length, 3);
  strictEqual(frame.scrollbackLines[2]?.includes("permission denied 2"), true);
});

test("live failure diagnostics wrap safely and report changed causes only once", () => {
  const store = new TaskStore();
  const id = store.createTask("unsafe\u001b[2Jtitle");
  const message = "permission denied /deploy/" + "x".repeat(100);
  store.update(id, { status: "failed", message });
  const renderer = new AnsiLiveRenderer(theme, 12, 2);
  const first = renderer.render(store.snapshot());
  if (first.kind !== "live") throw new Error("expected live frame");
  strictEqual(
    first.scrollbackLines.every((line) => displayWidth(line) <= 12),
    true,
  );
  strictEqual(first.scrollbackLines.join("").includes(message), true);
  strictEqual(first.scrollbackLines.join("").includes("\u001b[2J"), false);
  store.forceTerminalUpdate(id, { status: "failed", message: "final failure" });
  const changed = renderer.render(store.snapshot());
  if (changed.kind !== "live") throw new Error("expected live frame");
  strictEqual(changed.scrollbackLines.join("").includes("final failure"), true);
  const repeated = renderer.render(store.snapshot());
  if (repeated.kind !== "live") throw new Error("expected live frame");
  deepStrictEqual(repeated.scrollbackLines, []);
});

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

test("live ledger aligns CJK, emoji, combining marks and nested task columns", () => {
  const tasks = ["install packages", "한글 👩‍💻", "e\u0301\tbuild"].map((title, index) => ({
    ...determinate(`task-${index}`, title, 76 - index),
    depth: index,
    message: `phase-${index}`,
  }));
  const lines = liveLines(tasks);
  strictEqual(lines.length, 8);
  strictEqual(lines[0]?.startsWith("laqu"), true);
  strictEqual(lines[1]?.includes("TASK"), true);
  strictEqual(lines[1]?.includes("COUNT"), true);
  const taskLines = lines.slice(3, 6);
  deepStrictEqual(
    taskLines.map((line) => displayWidth(line.split("[")[0] ?? "")),
    [30, 30, 30],
  );
  deepStrictEqual(
    taskLines.map((line) => displayWidth(line.split("phase-")[0] ?? "")),
    [69, 69, 69],
  );
  strictEqual(
    taskLines.every((line) => displayWidth(line) === 100),
    true,
  );
  strictEqual(lines.at(-1), "3 running");
});

test("live ledger distinguishes pending tasks and reports actual lifecycle counts", () => {
  const tasks = [
    determinate("one", "install packages", 76),
    determinate("two", "build artifacts", 49),
    { ...determinate("three", "publish preview", 0), status: "pending" as const },
  ];
  const lines = liveLines(tasks);
  strictEqual(lines[3]?.startsWith("› install packages"), true);
  strictEqual(lines[5]?.startsWith("○ publish preview"), true);
  strictEqual(lines[5]?.includes("waiting"), true);
  strictEqual(lines.at(-1), "2 running · 1 waiting");
  const labelledWaiting = liveLines([{ ...tasks[0]!, message: "waiting" }]);
  strictEqual(labelledWaiting.at(-1), "1 running");
});

test("live ledger bars occupy exactly twenty cells with custom wide or empty glyphs", () => {
  for (const glyphs of [
    ["界", "🙂"],
    ["ab", "."],
    ["", ""],
    ["\u0301", "\t"],
  ] as const) {
    const custom = compileTheme({
      useColor: false,
      progressComplete: glyphs[0],
      progressIncomplete: glyphs[1],
    });
    const renderer = new AnsiLiveRenderer(custom, 80, 3);
    const frame = renderer.render(snapshot([determinate("one", "download", 76)], 1));
    if (frame.kind !== "live") throw new Error("expected live frame");
    const bar = frame.lines[0]?.match(/\[([^\]]*)\]/u)?.[1];
    strictEqual(displayWidth(bar ?? ""), 20);
    strictEqual(displayWidth(frame.lines[0] ?? ""), 80);
  }
});

test("live ledger keeps every frame within width and row budgets", () => {
  const tasks = Array.from({ length: 15 }, (_, index) => ({
    ...determinate(`task-${index}`, `작업 👩‍💻 ${"long ".repeat(40)}`, index),
    message: "bundling ".repeat(40),
  }));
  for (const columns of [1, 12, 40, 63, 64, 80, 120]) {
    for (const maxRows of [1, 2, 6, 7, 8, 12]) {
      const lines = liveLines(tasks, columns, maxRows);
      strictEqual(lines.length, maxRows);
      strictEqual(
        lines.every((line) => displayWidth(line) <= columns),
        true,
      );
      if (columns >= 2) {
        strictEqual(lines[maxRows >= 7 && columns >= 64 ? 3 : 0]?.startsWith("›"), true);
      }
      if (columns >= 64 && maxRows > 1) {
        strictEqual(
          lines.some((line) => line.includes("more tasks")),
          true,
        );
      }
    }
  }
  deepStrictEqual(liveLines([]), []);
});

test("live ledger prioritizes active tasks and summarizes pruned terminal tasks", () => {
  const tasks = [
    { ...task("done", "old-completed"), status: "succeeded" as const },
    ...Array.from({ length: 4 }, (_, index) => task(`task-${index}`, `active-${index}`)),
  ];
  const renderer = new AnsiLiveRenderer(theme, 80, 7);
  const frame = renderer.render({
    ...snapshot(tasks, 1),
    summary: { total: 9, running: 4, succeeded: 4, failed: 1, cancelled: 0, skipped: 0 },
  });
  if (frame.kind !== "live") throw new Error("expected live frame");
  strictEqual(frame.lines.length, 7);
  strictEqual(frame.lines[3]?.includes("active-0"), true);
  strictEqual(frame.lines[4], "4 more tasks...");
  strictEqual(frame.lines.at(-1), "4 running · 4 succeeded · 1 failed");
  strictEqual(
    frame.lines.some((line) => line.includes("old-completed")),
    false,
  );
});

test("live ledger preserves counter, aggregate, mixed and indeterminate semantics", () => {
  const parent = { ...determinate("parent", "parent", 50), aggregateFromChildren: true };
  const counter = {
    ...task("counter", "counter"),
    progress: { kind: "counter", current: 42 } as const,
  };
  const mixed = { ...task("mixed", "mixed"), aggregate: { kind: "mixed" } as const };
  const unknown = { ...task("unknown", "unknown"), progress: { kind: "indeterminate" } as const };
  const lines = liveLines([parent, counter, mixed, unknown], 100, 4);
  strictEqual(lines[0]?.includes("50%"), true);
  strictEqual(lines[0]?.includes("50/100"), false);
  strictEqual(lines[1]?.includes("42"), true);
  strictEqual(lines[1]?.includes("%"), false);
  strictEqual(lines[2]?.includes("mixed"), true);
  strictEqual(lines[3]?.includes("~"), true);
});

test("real indeterminate tasks keep their symbol across widths while parents remain mixed", () => {
  const store = new TaskStore();
  const own = store.createTask("standalone");
  store.update(own, { progress: { kind: "indeterminate" } });
  const parent = store.createTask("parent");
  store.update(parent, { progress: { kind: "indeterminate" } });
  store.createTask("unknown child", {}, parent);
  const state = store.snapshot();
  for (const columns of [60, 100]) {
    for (const symbol of ["~", "busy"]) {
      const custom = compileTheme({ useColor: false, progressIndeterminate: symbol });
      const frame = new AnsiLiveRenderer(custom, columns, 12).render(state);
      if (frame.kind !== "live") throw new Error("expected live frame");
      const ownRow = frame.lines.find((line) => line.includes("standalone")) ?? "";
      const parentRow = frame.lines.find((line) => line.includes("parent")) ?? "";
      strictEqual(ownRow.includes(symbol), true, `${columns} columns: ${ownRow}`);
      strictEqual(ownRow.includes("mixed"), false);
      strictEqual(parentRow.includes("mixed"), true);
    }
  }
});

test("live ledger sanitizes fields and resets colors before column padding", () => {
  const renderer = new AnsiLiveRenderer(compileTheme(), 100, 8);
  const frame = renderer.render(
    snapshot(
      [
        {
          ...determinate("one", "\u001b[2Junsafe\rtitle", 125),
          message: "\u001b]52;c;secret\u0007downloading",
          detail: "detail",
        },
      ],
      1,
    ),
  );
  if (frame.kind !== "live") throw new Error("expected live frame");
  strictEqual(
    frame.lines.some((line) => line.includes("\u001b[2J") || line.includes("\u001b]52")),
    false,
  );
  strictEqual(stripAnsi(frame.lines[3] ?? "").includes("100+%"), false);
  strictEqual(stripAnsi(frame.lines[3] ?? "").includes("125+%"), true);
  strictEqual(
    frame.lines.every((line) => displayWidth(line) <= 100),
    true,
  );
  strictEqual(frame.lines[3]?.endsWith("\u001b[0m"), true);
  strictEqual(stripAnsi(frame.lines[3] ?? "").includes("detail"), true);
});

function determinate(id: string, title: string, current: number): TaskSnapshot {
  return {
    ...task(id, title),
    progress: {
      kind: "determinate",
      current,
      total: 100,
      ratio: current / 100,
      overrun: current > 100,
    },
    aggregate: { kind: "ratio", ratio: current / 100, overrun: current > 100 },
  };
}

function liveLines(tasks: readonly TaskSnapshot[], columns = 100, maxRows = 12): readonly string[] {
  const frame = new AnsiLiveRenderer(theme, columns, maxRows).render(snapshot(tasks, 1));
  if (frame.kind !== "live") throw new Error("expected live frame");
  return frame.lines;
}

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
    aggregateFromChildren: false,
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
