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
  children: Set<string>;
  updatedAt: number;
  snapshottedTerminal: boolean;
  pruneCandidateQueued: boolean;
}

type TaskNodeUpdate = Partial<
  Pick<TaskNode, "title" | "status" | "progress" | "message" | "detail" | "weight">
>;

export class TaskStore {
  readonly #tasks = new Map<string, TaskNode>();
  readonly #rootIds = new Set<string>();
  readonly #logs: LogRecord[] = [];
  readonly #pendingTerminalSnapshots: string[] = [];
  readonly #pruneCandidates: string[] = [];
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
  #retainedTerminalTasks = 0;
  #pruneCandidateHead = 0;

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
    assertString(title, "title");
    assertTaskOptions(options);
    const parent = parentId === undefined ? undefined : this.#requireOpenParent(parentId);
    const progress = progressFromOptions(options);
    const weight = validatedWeight(options.weight);
    const id = `task-${this.#nextId}`;
    this.#nextId += 1;
    const now = Date.now();
    const node: TaskNode = {
      id,
      parentId,
      title,
      status: "running",
      progress,
      message: options.message,
      detail: options.detail,
      weight,
      children: new Set(),
      updatedAt: now,
      snapshottedTerminal: false,
      pruneCandidateQueued: false,
    };
    this.#tasks.set(id, node);
    this.#summaryCounts.total += 1;
    this.#summaryCounts.running += 1;

    if (parentId === undefined) {
      this.#rootIds.add(id);
    } else if (parent !== undefined) {
      parent.children.add(id);
      parent.updatedAt = now;
    }

    return id;
  }

  update(id: string, update: TaskNodeUpdate): void {
    const node = this.#tasks.get(id);
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

  forceTerminalUpdate(id: string, update: Pick<TaskNodeUpdate, "status" | "message">): void {
    const node = this.#tasks.get(id);
    if (node === undefined) {
      throw new Error(`Unknown task id: ${id}`);
    }
    const previousStatus = node.status;
    applyUpdate(node, update);
    this.#recordStatusTransition(node.id, previousStatus, node.status);
  }

  getProgress(id: string): ProgressState {
    const node = this.#tasks.get(id);
    if (node === undefined) {
      throw new Error(`Unknown task id: ${id}`);
    }
    return node.progress;
  }

  addLog(message: string): void {
    assertString(message, "message");
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
    this.#markTerminalTasksSnapshotted();
    return snapshot;
  }

  retentionStats(): {
    readonly retainedTasks: number;
    readonly retainedTerminalTasks: number;
    readonly pendingTerminalSnapshots: number;
    readonly pendingPruneCandidates: number;
  } {
    return {
      retainedTasks: this.#tasks.size,
      retainedTerminalTasks: this.#retainedTerminalTasks,
      pendingTerminalSnapshots: this.#pendingTerminalSnapshots.length,
      pendingPruneCandidates: this.#pruneCandidates.length - this.#pruneCandidateHead,
    };
  }

  #snapshotTasks(): readonly TaskSnapshot[] {
    const snapshots = new Map<string, TaskSnapshot>();
    const stack: { readonly id: string; readonly depth: number; readonly visited: boolean }[] = [];
    const rootIds = [...this.#rootIds];

    for (let index = rootIds.length - 1; index >= 0; index -= 1) {
      const id = rootIds[index];
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
        const childIds = [...node.children];
        for (let index = childIds.length - 1; index >= 0; index -= 1) {
          const childId = childIds[index];
          if (childId !== undefined) {
            stack.push({ id: childId, depth: item.depth + 1, visited: false });
          }
        }
        continue;
      }

      const children = [...node.children].map((childId) => requireSnapshot(snapshots, childId));
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

    return rootIds.map((id) => requireSnapshot(snapshots, id));
  }

  #requireNode(id: string): TaskNode {
    const node = this.#tasks.get(id);
    if (node === undefined) {
      throw new Error(`Unknown task id: ${id}`);
    }
    return node;
  }

  #requireOpenParent(id: string): TaskNode {
    const parent = this.#requireNode(id);
    if (isTerminalStatus(parent.status)) {
      throw new Error(`Cannot create child task under terminal task: ${id}`);
    }
    return parent;
  }

  #recordStatusTransition(id: string, previousStatus: TaskStatus, nextStatus: TaskStatus): void {
    if (previousStatus === nextStatus) {
      return;
    }
    decrementSummaryStatus(this.#summaryCounts, previousStatus);
    incrementSummaryStatus(this.#summaryCounts, nextStatus);
    if (!isTerminalStatus(previousStatus) && isTerminalStatus(nextStatus)) {
      this.#retainedTerminalTasks += 1;
      this.#pendingTerminalSnapshots.push(id);
    }
  }

  #pruneTerminalTasks(): void {
    while (this.#retainedTerminalTasks > this.#maxTerminalTasks) {
      const id = this.#pruneCandidates[this.#pruneCandidateHead];
      if (id === undefined) {
        break;
      }
      this.#pruneCandidateHead += 1;
      const node = this.#tasks.get(id);
      if (node === undefined) {
        continue;
      }
      node.pruneCandidateQueued = false;
      if (!node.snapshottedTerminal || !isTerminalStatus(node.status) || node.children.size > 0) {
        continue;
      }
      this.#removeTaskNode(node);
    }
    this.#compactPruneCandidates();
  }

  #markTerminalTasksSnapshotted(): void {
    for (const id of this.#pendingTerminalSnapshots) {
      const node = this.#tasks.get(id);
      if (node !== undefined && isTerminalStatus(node.status)) {
        node.snapshottedTerminal = true;
        this.#enqueuePruneCandidate(node);
      }
    }
    this.#pendingTerminalSnapshots.length = 0;
  }

  #enqueuePruneCandidate(node: TaskNode): void {
    if (
      node.pruneCandidateQueued ||
      !node.snapshottedTerminal ||
      !isTerminalStatus(node.status) ||
      node.children.size > 0
    ) {
      return;
    }
    node.pruneCandidateQueued = true;
    this.#pruneCandidates.push(node.id);
  }

  #removeTaskNode(node: TaskNode): void {
    this.#tasks.delete(node.id);
    this.#retainedTerminalTasks -= 1;
    if (node.parentId === undefined) {
      this.#rootIds.delete(node.id);
      return;
    }
    const parent = this.#tasks.get(node.parentId);
    if (parent !== undefined) {
      parent.children.delete(node.id);
      parent.updatedAt = Date.now();
      this.#enqueuePruneCandidate(parent);
    }
  }

  #compactPruneCandidates(): void {
    if (this.#pruneCandidateHead === this.#pruneCandidates.length) {
      this.#pruneCandidates.length = 0;
      this.#pruneCandidateHead = 0;
      return;
    }
    if (
      this.#pruneCandidateHead >= 1_024 &&
      this.#pruneCandidateHead * 2 >= this.#pruneCandidates.length
    ) {
      this.#pruneCandidates.splice(0, this.#pruneCandidateHead);
      this.#pruneCandidateHead = 0;
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

function assertTaskOptions(options: TaskOptions): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("task options must be an object");
  }
  if (options.message !== undefined) {
    assertString(options.message, "message");
  }
  if (options.detail !== undefined) {
    assertString(options.detail, "detail");
  }
  if (
    options.ratio !== undefined &&
    (options.total !== undefined || options.completed !== undefined)
  ) {
    throw new TypeError("task options must not mix ratio with total or completed progress");
  }
  if (options.signal !== undefined) {
    const signal = options.signal;
    if (
      typeof signal !== "object" ||
      signal === null ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    ) {
      throw new TypeError("signal must be an AbortSignal-compatible object");
    }
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
}

function requireSnapshot(snapshots: ReadonlyMap<string, TaskSnapshot>, id: string): TaskSnapshot {
  const snapshot = snapshots.get(id);
  if (snapshot === undefined) {
    throw new Error(`Missing task snapshot: ${id}`);
  }
  return snapshot;
}

function applyUpdate(node: TaskNode, update: TaskNodeUpdate): void {
  if (update.title !== undefined) {
    assertString(update.title, "title");
    node.title = update.title;
  }
  if (update.status !== undefined) {
    node.status = update.status;
  }
  if (update.progress !== undefined) {
    node.progress = update.progress;
  }
  if (Object.hasOwn(update, "message")) {
    if (update.message !== undefined) {
      assertString(update.message, "message");
    }
    node.message = update.message;
  }
  if (Object.hasOwn(update, "detail")) {
    if (update.detail !== undefined) {
      assertString(update.detail, "detail");
    }
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
