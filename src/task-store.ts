import type { TaskOptions } from "./types.js";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type ProgressState =
  | { readonly kind: "none" }
  | { readonly kind: "ratio"; readonly ratio: number; readonly overrun: boolean }
  | {
      readonly kind: "determinate";
      readonly current: number;
      readonly total: number;
      readonly ratio: number;
      readonly overrun: boolean;
    }
  | { readonly kind: "indeterminate" }
  | { readonly kind: "counter"; readonly current: number };

export type AggregateProgress =
  | { readonly kind: "none" }
  | { readonly kind: "ratio"; readonly ratio: number; readonly overrun: boolean }
  | { readonly kind: "mixed" };

export interface TaskSnapshot {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly title: string;
  readonly status: TaskStatus;
  readonly progress: ProgressState;
  readonly aggregate: AggregateProgress;
  readonly message: string | undefined;
  readonly detail: string | undefined;
  readonly weight: number;
  readonly depth: number;
  readonly children: readonly TaskSnapshot[];
  readonly updatedAt: number;
}

export interface RuntimeSnapshot {
  readonly tasks: readonly TaskSnapshot[];
  readonly logs: readonly LogRecord[];
  readonly createdAt: number;
}

export interface LogRecord {
  readonly message: string;
  readonly createdAt: number;
}

interface TaskNode {
  id: string;
  parentId: string | undefined;
  title: string;
  status: TaskStatus;
  progress: ProgressState;
  message: string | undefined;
  detail: string | undefined;
  weight: number;
  children: string[];
  updatedAt: number;
}

export class TaskStore {
  readonly #tasks = new Map<string, TaskNode>();
  readonly #rootIds: string[] = [];
  readonly #logs: LogRecord[] = [];
  #nextId = 1;

  createTask(title: string, options: TaskOptions = {}, parentId?: string): string {
    const id = `task-${this.#nextId}`;
    this.#nextId += 1;
    const now = Date.now();
    const node: TaskNode = {
      id,
      parentId,
      title,
      status: "running",
      progress: progressFromOptions(options),
      message: options.message,
      detail: options.detail,
      weight: options.weight ?? 1,
      children: [],
      updatedAt: now,
    };
    this.#tasks.set(id, node);

    if (parentId === undefined) {
      this.#rootIds.push(id);
    } else {
      const parent = this.#requireNode(parentId);
      parent.children.push(id);
      parent.updatedAt = now;
    }

    return id;
  }

  update(id: string, update: Partial<Omit<TaskNode, "id" | "parentId" | "children">>): void {
    const node = this.#requireNode(id);
    if (isTerminalStatus(node.status)) {
      return;
    }
    if (update.title !== undefined) {
      node.title = update.title;
    }
    if (update.status !== undefined) {
      node.status = update.status;
    }
    if (update.progress !== undefined) {
      node.progress = update.progress;
    }
    if (Object.hasOwn(update, "message")) {
      node.message = update.message;
    }
    if (Object.hasOwn(update, "detail")) {
      node.detail = update.detail;
    }
    if (update.weight !== undefined) {
      node.weight = update.weight;
    }
    node.updatedAt = Date.now();
  }

  getProgress(id: string): ProgressState {
    return this.#requireNode(id).progress;
  }

  addLog(message: string): void {
    this.#logs.push({ message, createdAt: Date.now() });
  }

  snapshot(): RuntimeSnapshot {
    return {
      tasks: this.#rootIds.map((id) => this.#snapshotNode(id, 0)),
      logs: [...this.#logs],
      createdAt: Date.now(),
    };
  }

  #snapshotNode(id: string, depth: number): TaskSnapshot {
    const node = this.#requireNode(id);
    const children = node.children.map((childId) => this.#snapshotNode(childId, depth + 1));
    return {
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      status: node.status,
      progress: node.progress,
      aggregate: aggregateProgress(node.progress, children),
      message: node.message,
      detail: node.detail,
      weight: node.weight,
      depth,
      children,
      updatedAt: node.updatedAt,
    };
  }

  #requireNode(id: string): TaskNode {
    const node = this.#tasks.get(id);
    if (node === undefined) {
      throw new Error(`Unknown task id: ${id}`);
    }
    return node;
  }
}

export function setTotalProgress(total: number, current = 0): ProgressState {
  assertFiniteNonNegative(total, "total");
  assertFiniteNonNegative(current, "current");
  return determinate(current, total);
}

export function setCompletedProgress(current: number, previous: ProgressState): ProgressState {
  assertFiniteNonNegative(current, "current");
  if (previous.kind === "determinate") {
    return determinate(current, previous.total);
  }
  return { kind: "counter", current };
}

export function advanceProgress(delta: number, previous: ProgressState): ProgressState {
  if (!Number.isFinite(delta)) {
    throw new TypeError("delta must be finite");
  }
  if (previous.kind === "determinate") {
    return determinate(Math.max(0, previous.current + delta), previous.total);
  }
  if (previous.kind === "counter") {
    return { kind: "counter", current: Math.max(0, previous.current + delta) };
  }
  return { kind: "counter", current: Math.max(0, delta) };
}

export function ratioProgress(ratio: number): ProgressState {
  if (!Number.isFinite(ratio)) {
    throw new TypeError("ratio must be finite");
  }
  return { kind: "ratio", ratio: clamp01(ratio), overrun: ratio > 1 };
}

function progressFromOptions(options: TaskOptions): ProgressState {
  if (options.total !== undefined) {
    return setTotalProgress(options.total, options.completed ?? 0);
  }
  if (options.ratio !== undefined) {
    return ratioProgress(options.ratio);
  }
  if (options.completed !== undefined) {
    return { kind: "counter", current: options.completed };
  }
  return { kind: "none" };
}

function determinate(current: number, total: number): ProgressState {
  const safeTotal = total === 0 ? 1 : total;
  return {
    kind: "determinate",
    current,
    total,
    ratio: clamp01(current / safeTotal),
    overrun: current > total,
  };
}

function aggregateProgress(
  ownProgress: ProgressState,
  children: readonly TaskSnapshot[],
): AggregateProgress {
  if (children.length === 0) {
    return aggregateFromProgress(ownProgress);
  }

  let weightedRatio = 0;
  let totalWeight = 0;
  let overrun = false;

  for (const child of children) {
    if (child.aggregate.kind === "mixed" || child.aggregate.kind === "none") {
      return { kind: "mixed" };
    }
    weightedRatio += child.aggregate.ratio * child.weight;
    totalWeight += child.weight;
    overrun = overrun || child.aggregate.overrun;
  }

  if (totalWeight === 0) {
    return { kind: "none" };
  }

  return { kind: "ratio", ratio: clamp01(weightedRatio / totalWeight), overrun };
}

function aggregateFromProgress(progress: ProgressState): AggregateProgress {
  switch (progress.kind) {
    case "determinate":
    case "ratio":
      return { kind: "ratio", ratio: progress.ratio, overrun: progress.overrun };
    case "counter":
    case "indeterminate":
      return { kind: "mixed" };
    case "none":
      return { kind: "none" };
  }
}

function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled"
  );
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
