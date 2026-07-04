import { logEvent, summaryEvent, taskEvent, type LaquEvent } from "./events.js";
import { renderSegments, text, type CompiledTheme } from "./theme.js";
import type { OutputFormat, ProgressPolicy, StreamCapability } from "./types.js";
import { sanitizeText, truncateToColumns } from "./width.js";
import type { LogRecord, RuntimeSnapshot, TaskSnapshot, TaskStatus } from "./task-store.js";

export type Frame =
  | {
      readonly kind: "live";
      readonly scrollbackLines: readonly string[];
      readonly lines: readonly string[];
    }
  | { readonly kind: "plain"; readonly lines: readonly string[] }
  | { readonly kind: "json"; readonly events: readonly LaquEvent[] }
  | { readonly kind: "none" };

export interface Renderer {
  render(snapshot: RuntimeSnapshot): Frame;
  finalize?(snapshot: RuntimeSnapshot): Frame;
}

export interface RendererDecision {
  readonly renderer: Renderer;
  readonly live: boolean;
  readonly jsonSerialization: JsonSerialization;
}

export type JsonSerialization = "none" | "ndjson" | "array";

export interface RendererOptions {
  readonly format: OutputFormat;
  readonly policy: ProgressPolicy;
  readonly capability: StreamCapability;
  readonly theme: CompiledTheme;
  readonly columns: number;
  readonly maxRows: number;
}

export function chooseRenderer(options: RendererOptions): RendererDecision {
  if (options.policy === "silent" || options.policy === "never") {
    return { renderer: new NullRenderer(), live: false, jsonSerialization: "none" };
  }
  if (options.policy === "jsonl" || options.format === "json" || options.format === "ndjson") {
    return {
      renderer: new JsonEventRenderer(),
      live: false,
      jsonSerialization:
        options.policy === "jsonl" || options.format === "ndjson" ? "ndjson" : "array",
    };
  }
  if (options.policy === "plain") {
    return {
      renderer: new PlainLogRenderer(options.theme, options.columns, options.maxRows),
      live: false,
      jsonSerialization: "none",
    };
  }
  if (
    options.policy === "always" ||
    (options.policy === "auto" && options.capability === "tty" && options.format === "human")
  ) {
    return {
      renderer: new AnsiLiveRenderer(options.theme, options.columns, options.maxRows),
      live: true,
      jsonSerialization: "none",
    };
  }
  return {
    renderer: new PlainLogRenderer(options.theme, options.columns, options.maxRows),
    live: false,
    jsonSerialization: "none",
  };
}

export class AnsiLiveRenderer implements Renderer {
  #seenLogSequence = 0;

  constructor(
    private readonly theme: CompiledTheme,
    private readonly columns: number,
    private readonly maxRows: number,
  ) {}

  render(snapshot: RuntimeSnapshot): Frame {
    const newLogs = logsAfterSequence(snapshot.logs, this.#seenLogSequence);
    const scrollbackLines = renderLogLines(newLogs, this.theme, this.columns);
    this.#seenLogSequence = lastLogSequence(snapshot.logs, this.#seenLogSequence);

    return {
      kind: "live",
      scrollbackLines,
      lines: rowsForSnapshot(snapshot, this.theme, this.columns, this.maxRows),
    };
  }
}

export class PlainLogRenderer implements Renderer {
  #seenTaskStates = new Map<string, string>();
  #seenLogSequence = 0;

  constructor(
    private readonly theme: CompiledTheme,
    private readonly columns: number,
    private readonly maxRows: number,
  ) {}

  render(snapshot: RuntimeSnapshot): Frame {
    const lines: string[] = [];
    const newLogs = logsAfterSequence(snapshot.logs, this.#seenLogSequence);
    lines.push(...renderLogLines(newLogs, this.theme, this.columns));
    this.#seenLogSequence = lastLogSequence(snapshot.logs, this.#seenLogSequence);

    const rows = flattenTasks(snapshot.tasks).slice(0, this.maxRows);
    pruneSeenTaskStates(this.#seenTaskStates, rows);

    for (const row of rows) {
      const state = `${row.status}:${row.message ?? ""}:${row.detail ?? ""}:${progressText(
        row,
        this.theme,
      )}`;
      if (this.#seenTaskStates.get(row.id) === state) {
        continue;
      }
      this.#seenTaskStates.set(row.id, state);
      lines.push(renderTaskRow(row, this.theme, this.columns));
    }

    return lines.length === 0 ? { kind: "none" } : { kind: "plain", lines };
  }
}

export class JsonEventRenderer implements Renderer {
  #seenTaskStates = new Map<string, string>();
  #seenLogSequence = 0;
  #summaryEmitted = false;

  render(snapshot: RuntimeSnapshot): Frame {
    const events: LaquEvent[] = [];
    const tasks = flattenTasks(snapshot.tasks);
    pruneSeenTaskStates(this.#seenTaskStates, tasks);

    for (const log of logsAfterSequence(snapshot.logs, this.#seenLogSequence)) {
      events.push(logEvent(log.message, log.createdAt));
    }
    this.#seenLogSequence = lastLogSequence(snapshot.logs, this.#seenLogSequence);

    for (const task of tasks) {
      const ratio = task.aggregate.kind === "ratio" ? task.aggregate.ratio : undefined;
      const overrun = task.aggregate.kind === "ratio" ? task.aggregate.overrun : undefined;
      const state = `${task.status}:${task.message ?? ""}:${task.detail ?? ""}:${task.aggregate.kind}:${
        ratio ?? ""
      }:${overrun ?? ""}`;
      if (this.#seenTaskStates.get(task.id) === state) {
        continue;
      }
      this.#seenTaskStates.set(task.id, state);
      events.push(taskEvent(task));
    }

    return events.length === 0 ? { kind: "none" } : { kind: "json", events };
  }

  finalize(snapshot: RuntimeSnapshot): Frame {
    const rendered = this.render(snapshot);
    const events = rendered.kind === "json" ? [...rendered.events] : [];
    if (!this.#summaryEmitted && snapshot.summary.total > 0) {
      events.push(summaryEvent(snapshot.summary, snapshot.createdAt));
      this.#summaryEmitted = true;
    }
    return events.length === 0 ? { kind: "none" } : { kind: "json", events };
  }
}

function renderLogLines(
  logs: readonly LogRecord[],
  theme: CompiledTheme,
  columns: number,
): string[] {
  return logs.map((log) => truncateToColumns(sanitizeText(log.message), columns, theme.tokens));
}

function logsAfterSequence(logs: readonly LogRecord[], seenSequence: number): readonly LogRecord[] {
  return logs.filter((log) => log.sequence > seenSequence);
}

function lastLogSequence(logs: readonly LogRecord[], fallback: number): number {
  return logs.at(-1)?.sequence ?? fallback;
}

export class NullRenderer implements Renderer {
  render(): Frame {
    return { kind: "none" };
  }
}

function rowsForSnapshot(
  snapshot: RuntimeSnapshot,
  theme: CompiledTheme,
  columns: number,
  maxRows: number,
): string[] {
  const rows = flattenTasks(snapshot.tasks);
  const visible = rows.slice(0, maxRows);
  const output = visible.map((task) => renderTaskRow(task, theme, columns));
  const hidden = rows.length - visible.length;
  if (hidden > 0) {
    output.push(truncateToColumns(`${hidden} more tasks...`, columns, theme.tokens));
  }
  return output;
}

function flattenTasks(tasks: readonly TaskSnapshot[]): TaskSnapshot[] {
  const rows: TaskSnapshot[] = [];
  const stack = [...tasks].reverse();
  while (stack.length > 0) {
    const task = stack.pop();
    if (task === undefined) {
      continue;
    }
    rows.push(task);
    for (let index = task.children.length - 1; index >= 0; index -= 1) {
      const child = task.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return rows;
}

function pruneSeenTaskStates(
  seenTaskStates: Map<string, string>,
  currentTasks: readonly TaskSnapshot[],
): void {
  const currentIds = new Set(currentTasks.map((task) => task.id));
  for (const id of seenTaskStates.keys()) {
    if (!currentIds.has(id)) {
      seenTaskStates.delete(id);
    }
  }
}

function renderTaskRow(task: TaskSnapshot, theme: CompiledTheme, columns: number): string {
  const symbol = statusSymbol(task, theme);
  const indent = theme.tokens.indent.repeat(task.depth);
  const progress = progressText(task, theme);
  const safeTitle = sanitizeText(task.title);
  const safeMessage = task.message === undefined ? undefined : sanitizeText(task.message);
  const safeDetail = task.detail === undefined ? undefined : sanitizeText(task.detail);
  const message = safeMessage === undefined ? "" : `${theme.tokens.gap}${safeMessage}`;
  const detail =
    safeDetail === undefined ? "" : `${theme.tokens.gap}${theme.format(text(safeDetail, "muted"))}`;
  const row = renderSegments(theme, [
    text(indent),
    text(symbol, statusStyle(task.status)),
    text(theme.tokens.gap),
    text(safeTitle),
    text(progress === "" ? "" : `${theme.tokens.gap}${progress}`, "accent"),
    text(message),
  ]);
  return truncateToColumns(`${row}${detail}`, columns, {
    overflowMarker: theme.tokens.overflowMarker,
  });
}

function statusSymbol(task: TaskSnapshot, theme: CompiledTheme): string {
  switch (task.status) {
    case "succeeded":
      return theme.tokens.successSymbol;
    case "failed":
      return theme.tokens.failSymbol;
    case "cancelled":
    case "skipped":
      return theme.tokens.cancelSymbol;
    case "pending":
      return theme.tokens.pendingSymbol;
    case "running":
      return theme.tokens.runningSymbol;
  }
}

function statusStyle(status: TaskStatus): "muted" | "success" | "error" | "warning" | "accent" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
    case "skipped":
      return "warning";
    case "pending":
      return "muted";
    case "running":
      return "accent";
  }
}

function progressText(task: TaskSnapshot, theme: CompiledTheme): string {
  if (task.progress.kind === "indeterminate") {
    return theme.tokens.progressIndeterminate;
  }
  if (task.aggregate.kind === "ratio") {
    const percent = Math.round(task.aggregate.ratio * 100);
    const suffix = task.aggregate.overrun ? "+" : "";
    return `${progressBar(task.aggregate.ratio, task.aggregate.overrun, theme)} ${percent}${suffix}%`;
  }
  if (task.aggregate.kind === "mixed") {
    return "mixed";
  }
  return "";
}

function progressBar(ratio: number, overrun: boolean, theme: CompiledTheme): string {
  const width = 20;
  const completed = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const incomplete = width - completed;
  const tail = overrun ? "+" : "";
  return `[${theme.tokens.progressComplete.repeat(
    completed,
  )}${theme.tokens.progressIncomplete.repeat(incomplete)}${tail}]`;
}
