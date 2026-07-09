import type {
  AggregateProgress,
  TaskSnapshot,
  TaskSummaryCounts,
  TaskStatus,
} from "./task-store.js";

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
    readonly parentId?: string;
    readonly status: TaskStatus;
    readonly progress: LaquEventProgress;
    readonly message?: string;
    readonly detail?: string;
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
    createdAt: Date.now(),
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      progress: eventProgress(task.aggregate),
      depth: task.depth,
      ...(task.parentId === undefined ? {} : { parentId: task.parentId }),
      ...(task.message === undefined ? {} : { message: task.message }),
      ...(task.detail === undefined ? {} : { detail: task.detail }),
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

export function summaryEvent(counts: TaskSummaryCounts, createdAt: number): LaquSummaryEvent {
  return {
    schema: LAQU_EVENT_SCHEMA,
    version: LAQU_EVENT_SCHEMA_VERSION,
    type: "summary",
    createdAt,
    tasks: {
      total: counts.total,
      running: counts.running,
      succeeded: counts.succeeded,
      failed: counts.failed,
      cancelled: counts.cancelled,
      skipped: counts.skipped,
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
