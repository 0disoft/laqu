import { logEvent, summaryEvent, taskEvent, type LaquEvent } from "./events.js";
import { renderSegments, text, type CompiledTheme } from "./theme.js";
import type { OutputFormat, ProgressPolicy, StreamCapability } from "./types.js";
import { truncateToColumns } from "./width.js";
import type { RuntimeSnapshot, TaskSnapshot, TaskStatus } from "./task-store.js";

export type Frame =
  | { readonly kind: "live"; readonly lines: readonly string[] }
  | { readonly kind: "plain"; readonly lines: readonly string[] }
  | { readonly kind: "json"; readonly events: readonly LaquEvent[] }
  | { readonly kind: "none" };

export interface Renderer {
  render(snapshot: RuntimeSnapshot): Frame;
}

export interface RendererDecision {
  readonly renderer: Renderer;
  readonly live: boolean;
}

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
    return { renderer: new NullRenderer(), live: false };
  }
  if (options.policy === "jsonl" || options.format === "json" || options.format === "ndjson") {
    return { renderer: new JsonEventRenderer(), live: false };
  }
  if (options.policy === "plain") {
    return {
      renderer: new PlainLogRenderer(options.theme, options.columns, options.maxRows),
      live: false,
    };
  }
  if (
    options.policy === "always" ||
    (options.policy === "auto" && options.capability === "tty" && options.format === "human")
  ) {
    return {
      renderer: new AnsiLiveRenderer(options.theme, options.columns, options.maxRows),
      live: true,
    };
  }
  return {
    renderer: new PlainLogRenderer(options.theme, options.columns, options.maxRows),
    live: false,
  };
}

export class AnsiLiveRenderer implements Renderer {
  constructor(
    private readonly theme: CompiledTheme,
    private readonly columns: number,
    private readonly maxRows: number,
  ) {}

  render(snapshot: RuntimeSnapshot): Frame {
    return {
      kind: "live",
      lines: rowsForSnapshot(snapshot, this.theme, this.columns, this.maxRows),
    };
  }
}

export class PlainLogRenderer implements Renderer {
  #seenTaskStates = new Map<string, string>();
  #seenLogs = 0;

  constructor(
    private readonly theme: CompiledTheme,
    private readonly columns: number,
    private readonly maxRows: number,
  ) {}

  render(snapshot: RuntimeSnapshot): Frame {
    const lines: string[] = [];
    for (const log of snapshot.logs.slice(this.#seenLogs)) {
      lines.push(truncateToColumns(log.message, this.columns, this.theme.tokens));
    }
    this.#seenLogs = snapshot.logs.length;

    for (const row of flattenTasks(snapshot.tasks).slice(0, this.maxRows)) {
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
  #seenLogs = 0;

  render(snapshot: RuntimeSnapshot): Frame {
    const events: LaquEvent[] = [];

    for (const log of snapshot.logs.slice(this.#seenLogs)) {
      events.push(logEvent(log.message, log.createdAt));
    }
    this.#seenLogs = snapshot.logs.length;

    for (const task of flattenTasks(snapshot.tasks)) {
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

    if (
      events.length > 0 &&
      flattenTasks(snapshot.tasks).every((task) => task.status !== "running")
    ) {
      events.push(summaryEvent(snapshot.tasks, snapshot.createdAt));
    }

    return events.length === 0 ? { kind: "none" } : { kind: "json", events };
  }
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
    output.push(truncateToColumns(`${hidden} more tasks…`, columns, theme.tokens));
  }
  return output;
}

function flattenTasks(tasks: readonly TaskSnapshot[]): TaskSnapshot[] {
  const rows: TaskSnapshot[] = [];
  for (const task of tasks) {
    rows.push(task);
    rows.push(...flattenTasks(task.children));
  }
  return rows;
}

function renderTaskRow(task: TaskSnapshot, theme: CompiledTheme, columns: number): string {
  const symbol = statusSymbol(task, theme);
  const indent = theme.tokens.indent.repeat(task.depth);
  const progress = progressText(task, theme);
  const message = task.message === undefined ? "" : `${theme.tokens.gap}${task.message}`;
  const detail =
    task.detail === undefined
      ? ""
      : `${theme.tokens.gap}${theme.format(text(task.detail, "muted"))}`;
  const row = renderSegments(theme, [
    text(indent),
    text(symbol, statusStyle(task.status)),
    text(theme.tokens.gap),
    text(task.title),
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
