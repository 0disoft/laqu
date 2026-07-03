import type { AggregateProgress, TaskSnapshot, TaskStatus } from "./task-store.js";

export const LAQU_EVENT_SCHEMA = "laqu.event";
export const LAQU_EVENT_SCHEMA_VERSION = 1;

export type LaquEvent = LaquTaskEvent | LaquLogEvent | LaquSummaryEvent;

export interface LaquEventBase {
  readonly schema: typeof LAQU_EVENT_SCHEMA;
  readonly version: typeof LAQU_EVENT_SCHEMA_VERSION;
  readonly type: LaquEvent["type"];
  readonly createdAt: number;
}

export interface LaquTaskEvent extends Omit<LaquEventBase, "type"> {
  readonly type: "task";
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly parentId: string | undefined;
    readonly status: TaskStatus;
    readonly progress: LaquEventProgress;
    readonly message: string | undefined;
    readonly detail: string | undefined;
    readonly depth: number;
  };
}

export interface LaquLogEvent extends Omit<LaquEventBase, "type"> {
  readonly type: "log";
  readonly message: string;
}

export interface LaquSummaryEvent extends Omit<LaquEventBase, "type"> {
  readonly type: "summary";
  readonly tasks: {
    readonly total: number;
    readonly running: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly skipped: number;
  };
}

export type LaquEventProgress =
  | { readonly kind: "none" }
  | { readonly kind: "mixed" }
  | { readonly kind: "ratio"; readonly ratio: number; readonly overrun: boolean };

export function taskEvent(task: TaskSnapshot): LaquTaskEvent {
  return {
    schema: LAQU_EVENT_SCHEMA,
    version: LAQU_EVENT_SCHEMA_VERSION,
    type: "task",
    createdAt: task.updatedAt,
    task: {
      id: task.id,
      title: task.title,
      parentId: task.parentId,
      status: task.status,
      progress: eventProgress(task.aggregate),
      message: task.message,
      detail: task.detail,
      depth: task.depth,
    },
  };
}

export function logEvent(message: string, createdAt: number): LaquLogEvent {
  return {
    schema: LAQU_EVENT_SCHEMA,
    version: LAQU_EVENT_SCHEMA_VERSION,
    type: "log",
    message,
    createdAt,
  };
}

export function summaryEvent(tasks: readonly TaskSnapshot[], createdAt: number): LaquSummaryEvent {
  const flatTasks = flattenTasks(tasks);
  return {
    schema: LAQU_EVENT_SCHEMA,
    version: LAQU_EVENT_SCHEMA_VERSION,
    type: "summary",
    createdAt,
    tasks: {
      total: flatTasks.length,
      running: countByStatus(flatTasks, "running"),
      succeeded: countByStatus(flatTasks, "succeeded"),
      failed: countByStatus(flatTasks, "failed"),
      cancelled: countByStatus(flatTasks, "cancelled"),
      skipped: countByStatus(flatTasks, "skipped"),
    },
  };
}

function eventProgress(progress: AggregateProgress): LaquEventProgress {
  switch (progress.kind) {
    case "none":
      return { kind: "none" };
    case "mixed":
      return { kind: "mixed" };
    case "ratio":
      return { kind: "ratio", ratio: progress.ratio, overrun: progress.overrun };
  }
}

function flattenTasks(tasks: readonly TaskSnapshot[]): TaskSnapshot[] {
  const flatTasks: TaskSnapshot[] = [];
  for (const task of tasks) {
    flatTasks.push(task);
    flatTasks.push(...flattenTasks(task.children));
  }
  return flatTasks;
}

function countByStatus(tasks: readonly TaskSnapshot[], status: TaskStatus): number {
  return tasks.filter((task) => task.status === status).length;
}
