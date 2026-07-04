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
  readonly summary: TaskSummaryCounts;
  readonly createdAt: number;
}

export interface TaskSummaryCounts {
  readonly total: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly skipped: number;
}

export interface LogRecord {
  readonly message: string;
  readonly createdAt: number;
  readonly sequence: number;
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
  readonly #prunedTerminalIds = new Set<string>();
  readonly #snapshottedTerminalIds = new Set<string>();
  readonly #terminalOrder: string[] = [];
  readonly #maxLogs: number;
  readonly #maxTerminalTasks: number;
  readonly #summaryCounts = {
    total: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  #nextId = 1;
  #nextLogSequence = 1;

  constructor(
    options: {
      readonly maxLogs?: number | undefined;
      readonly maxTerminalTasks?: number | undefined;
    } = {},
  ) {
    this.#maxLogs = validatedMaxRecords(options.maxLogs ?? 1_000, "maxLogs");
    this.#maxTerminalTasks = validatedMaxRecords(
      options.maxTerminalTasks ?? 1_000,
      "maxTerminalTasks",
    );
  }

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
      weight: validatedWeight(options.weight),
      children: [],
      updatedAt: now,
    };
    this.#tasks.set(id, node);
    this.#summaryCounts.total += 1;
    this.#summaryCounts.running += 1;

    if (parentId === undefined) {
      this.#rootIds.push(id);
    } else {
      const parent = this.#requireNode(parentId);
      if (isTerminalStatus(parent.status)) {
        this.#tasks.delete(id);
        this.#summaryCounts.total -= 1;
        this.#summaryCounts.running -= 1;
        throw new Error(`Cannot create child task under terminal task: ${parentId}`);
      }
      parent.children.push(id);
      parent.updatedAt = now;
    }

    return id;
  }

  update(id: string, update: Partial<Omit<TaskNode, "id" | "parentId" | "children">>): void {
    const node = this.#tasks.get(id);
    if (node === undefined && this.#prunedTerminalIds.has(id)) {
      return;
    }
    if (node === undefined) {
      throw new Error(`Unknown task id: ${id}`);
    }
    if (isTerminalStatus(node.status)) {
      return;
    }
    const previousStatus = node.status;
    applyUpdate(node, update);
    this.#recordStatusTransition(node.id, previousStatus, node.status);
  }

  forceTerminalUpdate(
    id: string,
    update: Pick<Partial<Omit<TaskNode, "id" | "parentId" | "children">>, "status" | "message">,
  ): void {
    const node = this.#tasks.get(id);
    if (node === undefined && this.#prunedTerminalIds.has(id)) {
      return;
    }
    if (node === undefined) {
      throw new Error(`Unknown task id: ${id}`);
    }
    const previousStatus = node.status;
    applyUpdate(node, update);
    this.#recordStatusTransition(node.id, previousStatus, node.status);
  }

  getProgress(id: string): ProgressState {
    const node = this.#tasks.get(id);
    if (node === undefined && this.#prunedTerminalIds.has(id)) {
      return { kind: "none" };
    }
    if (node === undefined) {
      throw new Error(`Unknown task id: ${id}`);
    }
    return node.progress;
  }

  addLog(message: string): void {
    if (this.#maxLogs === 0) {
      this.#nextLogSequence += 1;
      return;
    }
    this.#logs.push({ message, createdAt: Date.now(), sequence: this.#nextLogSequence });
    this.#nextLogSequence += 1;
    const excess = this.#logs.length - this.#maxLogs;
    if (excess > 0) {
      this.#logs.splice(0, excess);
    }
  }

  snapshot(): RuntimeSnapshot {
    const snapshot = {
      tasks: this.#snapshotTasks(),
      logs: [...this.#logs],
      summary: { ...this.#summaryCounts },
      createdAt: Date.now(),
    };
    this.#pruneTerminalTasks();
    rememberTerminalTasks(snapshot.tasks, this.#snapshottedTerminalIds);
    return snapshot;
  }

  #snapshotTasks(): readonly TaskSnapshot[] {
    const snapshots = new Map<string, TaskSnapshot>();
    const stack: { readonly id: string; readonly depth: number; readonly visited: boolean }[] = [];

    for (let index = this.#rootIds.length - 1; index >= 0; index -= 1) {
      const id = this.#rootIds[index];
      if (id !== undefined) {
        stack.push({ id, depth: 0, visited: false });
      }
    }

    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined) {
        continue;
      }
      const node = this.#requireNode(item.id);
      if (!item.visited) {
        stack.push({ id: item.id, depth: item.depth, visited: true });
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const childId = node.children[index];
          if (childId !== undefined) {
            stack.push({ id: childId, depth: item.depth + 1, visited: false });
          }
        }
        continue;
      }

      const children = node.children.map((childId) => requireSnapshot(snapshots, childId));
      snapshots.set(node.id, {
        id: node.id,
        parentId: node.parentId,
        title: node.title,
        status: node.status,
        progress: node.progress,
        aggregate: aggregateProgress(node.progress, children),
        message: node.message,
        detail: node.detail,
        weight: node.weight,
        depth: item.depth,
        children,
        updatedAt: node.updatedAt,
      });
    }

    return this.#rootIds.map((id) => requireSnapshot(snapshots, id));
  }

  #requireNode(id: string): TaskNode {
    const node = this.#tasks.get(id);
    if (node === undefined) {
      if (this.#prunedTerminalIds.has(id)) {
        throw new Error(`Task id was pruned after terminal retention: ${id}`);
      }
      throw new Error(`Unknown task id: ${id}`);
    }
    return node;
  }

  #recordStatusTransition(id: string, previousStatus: TaskStatus, nextStatus: TaskStatus): void {
    if (previousStatus === nextStatus) {
      return;
    }
    decrementSummaryStatus(this.#summaryCounts, previousStatus);
    incrementSummaryStatus(this.#summaryCounts, nextStatus);
    if (!isTerminalStatus(previousStatus) && isTerminalStatus(nextStatus)) {
      this.#terminalOrder.push(id);
    }
  }

  #pruneTerminalTasks(): void {
    let retainedTerminalTasks = this.#countRetainedTerminalTasks();
    while (retainedTerminalTasks > this.#maxTerminalTasks) {
      const orderIndex = this.#terminalOrder.findIndex((id) => {
        const node = this.#tasks.get(id);
        return (
          node === undefined ||
          (this.#snapshottedTerminalIds.has(id) &&
            isTerminalStatus(node.status) &&
            node.children.length === 0)
        );
      });
      if (orderIndex === -1) {
        return;
      }
      const id = this.#terminalOrder.splice(orderIndex, 1)[0];
      if (id === undefined) {
        return;
      }
      const node = this.#tasks.get(id);
      if (node === undefined || !isTerminalStatus(node.status) || node.children.length > 0) {
        continue;
      }
      this.#removeTaskNode(node);
      retainedTerminalTasks -= 1;
    }
  }

  #countRetainedTerminalTasks(): number {
    let count = 0;
    for (const node of this.#tasks.values()) {
      if (isTerminalStatus(node.status)) {
        count += 1;
      }
    }
    return count;
  }

  #removeTaskNode(node: TaskNode): void {
    this.#tasks.delete(node.id);
    this.#prunedTerminalIds.add(node.id);
    this.#snapshottedTerminalIds.delete(node.id);
    if (node.parentId === undefined) {
      removeArrayItem(this.#rootIds, node.id);
      return;
    }
    const parent = this.#tasks.get(node.parentId);
    if (parent !== undefined) {
      removeArrayItem(parent.children, node.id);
      parent.updatedAt = Date.now();
    }
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
    assertFiniteNonNegative(options.completed, "completed");
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
    if (child.weight === 0) {
      continue;
    }
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

function incrementSummaryStatus(
  counts: {
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    skipped: number;
  },
  status: TaskStatus,
): void {
  switch (status) {
    case "running":
      counts.running += 1;
      return;
    case "succeeded":
      counts.succeeded += 1;
      return;
    case "failed":
      counts.failed += 1;
      return;
    case "cancelled":
      counts.cancelled += 1;
      return;
    case "skipped":
      counts.skipped += 1;
      return;
    case "pending":
      return;
  }
}

function decrementSummaryStatus(
  counts: {
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    skipped: number;
  },
  status: TaskStatus,
): void {
  switch (status) {
    case "running":
      counts.running -= 1;
      return;
    case "succeeded":
      counts.succeeded -= 1;
      return;
    case "failed":
      counts.failed -= 1;
      return;
    case "cancelled":
      counts.cancelled -= 1;
      return;
    case "skipped":
      counts.skipped -= 1;
      return;
    case "pending":
      return;
  }
}

function validatedWeight(weight: number | undefined): number {
  if (weight === undefined) {
    return 1;
  }
  assertFiniteNonNegative(weight, "weight");
  return weight;
}

function validatedMaxRecords(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a safe non-negative integer`);
  }
  return value;
}

function requireSnapshot(snapshots: ReadonlyMap<string, TaskSnapshot>, id: string): TaskSnapshot {
  const snapshot = snapshots.get(id);
  if (snapshot === undefined) {
    throw new Error(`Missing task snapshot: ${id}`);
  }
  return snapshot;
}

function applyUpdate(
  node: TaskNode,
  update: Partial<Omit<TaskNode, "id" | "parentId" | "children">>,
): void {
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
    node.weight = validatedWeight(update.weight);
  }
  node.updatedAt = Date.now();
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function removeArrayItem(items: string[], item: string): void {
  const index = items.indexOf(item);
  if (index !== -1) {
    items.splice(index, 1);
  }
}

function rememberTerminalTasks(tasks: readonly TaskSnapshot[], seenTerminalIds: Set<string>): void {
  const stack = [...tasks].reverse();
  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) {
      continue;
    }
    if (isTerminalStatus(task.status)) {
      seenTerminalIds.add(task.id);
    }
    for (let index = task.children.length - 1; index >= 0; index -= 1) {
      const child = task.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
}
