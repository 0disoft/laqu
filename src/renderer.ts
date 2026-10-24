import { logEvent, summaryEvent, taskEvent, type LaquEvent } from "./events.js";
import { packageVersion } from "./package-info.js";
import { renderSegments, text, type CompiledTheme } from "./theme.js";
import type { OutputFormat, ProgressPolicy, StreamCapability } from "./types.js";
import { displayWidth, sanitizeText, truncateToColumns, wrapToColumns } from "./width.js";
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
  readonly columns: number | (() => number);
  readonly maxRows: number | (() => number);
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
      renderer: new PlainLogRenderer(options.theme),
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
    renderer: new PlainLogRenderer(options.theme),
    live: false,
    jsonSerialization: "none",
  };
}

export class AnsiLiveRenderer implements Renderer {
  #seenLogSequence = 0;
  readonly #seenFailures = new Map<string, string>();

  constructor(
    private readonly theme: CompiledTheme,
    private readonly columns: number | (() => number),
    private readonly maxRows: number | (() => number),
  ) {}

  render(snapshot: RuntimeSnapshot): Frame {
    const columns = resolveLayoutValue(this.columns);
    const maxRows = resolveLayoutValue(this.maxRows);
    const rows = flattenTasks(snapshot.tasks);
    const newLogs = logsAfterSequence(snapshot.logs, this.#seenLogSequence);
    const scrollbackLines = renderLogLines(newLogs, this.theme, columns);
    this.#seenLogSequence = lastLogSequence(snapshot.logs, this.#seenLogSequence);
    const failures = rows.filter((task) => task.status === "failed");
    pruneSeenTaskStates(this.#seenFailures, failures);
    for (const task of failures) {
      const state = JSON.stringify([task.title, task.message, task.detail]);
      if (this.#seenFailures.get(task.id) === state) continue;
      this.#seenFailures.set(task.id, state);
      for (const line of wrapToColumns(
        renderTaskRow(task, this.theme),
        columns,
        this.theme.tokens,
      )) {
        scrollbackLines.push(line);
      }
    }

    return {
      kind: "live",
      scrollbackLines,
      lines: rowsForSnapshot(snapshot, this.theme, columns, maxRows, rows),
    };
  }
}

export class PlainLogRenderer implements Renderer {
  #seenTaskStates = new Map<string, string>();
  #seenLogSequence = 0;

  constructor(
    private readonly theme: CompiledTheme,
    _columns?: number,
    _maxRows?: number,
  ) {}

  render(snapshot: RuntimeSnapshot): Frame {
    const lines: string[] = [];
    if (snapshot.outputRecords === undefined) {
      const newLogs = logsAfterSequence(snapshot.logs, this.#seenLogSequence);
      lines.push(...newLogs.map((log) => sanitizeText(log.message)));
    } else {
      for (const record of snapshot.outputRecords) {
        if (record.kind === "log") {
          lines.push(sanitizeText(record.log.message));
        } else {
          lines.push(renderTaskRow(record.task, this.theme));
          this.#seenTaskStates.set(record.task.id, humanTaskStateKey(record.task));
        }
      }
    }
    this.#seenLogSequence = lastLogSequence(snapshot.logs, this.#seenLogSequence);

    const rows = flattenTasks(snapshot.tasks);
    pruneSeenTaskStates(this.#seenTaskStates, rows);

    for (const row of rows) {
      const state = humanTaskStateKey(row);
      if (this.#seenTaskStates.get(row.id) === state) {
        continue;
      }
      this.#seenTaskStates.set(row.id, state);
      lines.push(renderTaskRow(row, this.theme));
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
    if (snapshot.outputRecords === undefined) {
      for (const log of logsAfterSequence(snapshot.logs, this.#seenLogSequence)) {
        events.push(logEvent(log.message, log.createdAt));
      }
    } else {
      for (const record of snapshot.outputRecords) {
        if (record.kind === "log") {
          events.push(logEvent(record.log.message, record.log.createdAt));
        } else {
          events.push(taskEvent(record.task, record.createdAt));
          this.#seenTaskStates.set(record.task.id, taskStateKey(record.task));
        }
      }
    }
    this.#seenLogSequence = lastLogSequence(snapshot.logs, this.#seenLogSequence);
    pruneSeenTaskStates(this.#seenTaskStates, tasks);

    for (const task of tasks) {
      const state = taskStateKey(task);
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
  rows: readonly TaskSnapshot[],
): string[] {
  const prioritized = prioritizeTasks(rows);
  if (rows.length === 0) {
    return [];
  }
  // Only spend rows on decoration when at least two task/overflow rows remain.
  const ledger = columns >= 64;
  const decorated = ledger && maxRows >= 7;
  const available = decorated ? maxRows - 5 : maxRows;
  const taskBudget = rows.length > available && available > 1 ? available - 1 : available;
  const visible = prioritized.slice(0, taskBudget);
  const layout = ledger ? ledgerLayout(visible, columns) : undefined;
  const output = visible.map((task) =>
    layout === undefined
      ? renderTaskRow(task, theme, columns)
      : renderLedgerRow(task, theme, layout),
  );
  const hidden = rows.length - visible.length;
  if (hidden > 0 && output.length < available) {
    output.push(truncateToColumns(`${hidden} more tasks...`, columns, theme.tokens));
  }
  if (decorated && layout !== undefined) {
    const rule = theme.format(text("─".repeat(columns), "muted"));
    const heading = `laqu ${packageVersion}`;
    output.unshift(
      `${theme.format(text("laqu", "accent"))} ${theme.format(text(packageVersion, "muted"))}  ${theme.format(text("─".repeat(Math.max(0, columns - displayWidth(heading) - 2)), "muted"))}`,
      theme.format(
        text(ledgerCells(["TASK", "PROGRESS", "COUNT", "%", "STATE"], layout, theme), "muted"),
      ),
      rule,
    );
    output.push(
      rule,
      truncateToColumns(ledgerSummary(snapshot, rows, theme), columns, theme.tokens),
    );
  }
  return output;
}

type LedgerLayout = readonly [number, number, number, number, number];

function ledgerLayout(tasks: readonly TaskSnapshot[], columns: number): LedgerLayout {
  const title = Math.max(14, Math.min(32, Math.floor(columns * 0.28)));
  const count = tasks.reduce(
    (width, task) => Math.max(width, Math.min(12, displayWidth(ledgerCount(task)))),
    5,
  );
  // Five cells, separated by two spaces each; keep the bar at exactly 20 cells.
  const countWidth = Math.min(count, columns - title - 22 - 5 - 8 - 8);
  return [title, 22, countWidth, 5, columns - title - 22 - countWidth - 5 - 8];
}

function ledgerCell(value: string, width: number, theme: CompiledTheme, right = false): string {
  const clipped = truncateToColumns(value, width, theme.tokens);
  const padding = " ".repeat(Math.max(0, width - displayWidth(clipped)));
  return right ? `${padding}${clipped}` : `${clipped}${padding}`;
}

function ledgerCells(
  values: readonly string[],
  layout: LedgerLayout,
  theme: CompiledTheme,
): string {
  return values
    .map((value, index) => ledgerCell(value, layout[index] ?? 0, theme, index === 2 || index === 3))
    .join("  ");
}

function renderLedgerRow(task: TaskSnapshot, theme: CompiledTheme, layout: LedgerLayout): string {
  const [bar, count, percent] = ledgerProgress(task, theme);
  const title = renderSegments(theme, [
    text(theme.tokens.indent.repeat(Math.min(task.depth, layout[0]))),
    text(statusSymbol(task, theme), statusStyle(task.status)),
    text(theme.tokens.gap),
    text(
      sanitizeText(task.title),
      task.status === "running" ? undefined : statusStyle(task.status),
    ),
  ]);
  const state =
    task.message === undefined
      ? task.status === "pending"
        ? "waiting"
        : task.status
      : sanitizeText(task.message);
  const detail = task.detail === undefined ? "" : `${theme.tokens.gap}${sanitizeText(task.detail)}`;
  const cells = [title, bar, count, percent, `${state}${detail}`];
  return cells
    .map((value, index) => {
      if (index === 0 || index === 1) {
        return ledgerCell(value, layout[index], theme);
      }
      const style = statusStyle(task.status);
      return theme.format(
        text(ledgerCell(value, layout[index] ?? 0, theme, index === 2 || index === 3), style),
      );
    })
    .join("  ");
}

function ledgerCount(task: TaskSnapshot): string {
  return !task.aggregateFromChildren
    ? task.progress.kind === "determinate"
      ? `${task.progress.current}/${task.progress.total}`
      : task.progress.kind === "counter"
        ? String(task.progress.current)
        : ""
    : "";
}

function ledgerProgress(
  task: TaskSnapshot,
  theme: CompiledTheme,
): readonly [string, string, string] {
  const count = ledgerCount(task);
  if (task.aggregate.kind === "ratio") {
    const complete = Math.max(0, Math.min(20, Math.round(task.aggregate.ratio * 20)));
    const bar = `[${theme.format(text(progressCells(theme.tokens.progressComplete, complete), statusStyle(task.status)))}${theme.format(text(progressCells(theme.tokens.progressIncomplete, 20 - complete), "muted"))}]`;
    return [
      bar,
      count,
      `${Math.round(task.aggregate.ratio * 100)}${task.aggregate.overrun ? "+" : ""}%`,
    ];
  }
  const bar =
    !task.aggregateFromChildren && task.progress.kind === "indeterminate"
      ? theme.tokens.progressIndeterminate
      : task.aggregate.kind === "mixed"
        ? "mixed"
        : "";
  return [theme.format(text(bar, "muted")), count, ""];
}

function progressCells(token: string, width: number): string {
  const glyph = truncateToColumns(token, width);
  const glyphWidth = displayWidth(glyph);
  const repeated = glyphWidth === 0 ? "" : glyph.repeat(Math.floor(width / glyphWidth));
  return `${repeated}${" ".repeat(width - displayWidth(repeated))}`;
}

function ledgerSummary(
  snapshot: RuntimeSnapshot,
  rows: readonly TaskSnapshot[],
  theme: CompiledTheme,
): string {
  const waiting = rows.filter((task) => task.status === "pending").length;
  const counts = [
    [snapshot.summary.running, "running", "accent"],
    [waiting, "waiting", "muted"],
    [snapshot.summary.succeeded, "succeeded", "success"],
    [snapshot.summary.failed, "failed", "error"],
    [snapshot.summary.cancelled, "cancelled", "warning"],
    [snapshot.summary.skipped, "skipped", "warning"],
  ] as const;
  return counts
    .filter(([count]) => count > 0)
    .map(([count, label, style]) => theme.format(text(`${count} ${label}`, style)))
    .join(" · ");
}

function prioritizeTasks(tasks: readonly TaskSnapshot[]): TaskSnapshot[] {
  const failed: TaskSnapshot[] = [];
  const active: TaskSnapshot[] = [];
  const terminal: TaskSnapshot[] = [];
  for (const task of tasks) {
    if (task.status === "failed") {
      failed.push(task);
    } else if (task.status === "pending" || task.status === "running") {
      active.push(task);
    } else {
      terminal.push(task);
    }
  }
  return [...failed, ...active, ...terminal];
}

function resolveLayoutValue(value: number | (() => number)): number {
  return typeof value === "function" ? value() : value;
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

function renderTaskRow(task: TaskSnapshot, theme: CompiledTheme, columns?: number): string {
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
  const rendered = `${row}${detail}`;
  return columns === undefined
    ? rendered
    : truncateToColumns(rendered, columns, { overflowMarker: theme.tokens.overflowMarker });
}

function taskStateKey(task: TaskSnapshot): string {
  return JSON.stringify([task.status, task.message, task.detail, task.progress, task.aggregate]);
}

function humanTaskStateKey(task: TaskSnapshot): string {
  return `${taskStateKey(task)}:${task.aggregateFromChildren}`;
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
  if (!task.aggregateFromChildren && task.progress.kind === "indeterminate") {
    return theme.tokens.progressIndeterminate;
  }
  if (!task.aggregateFromChildren && task.progress.kind === "counter") {
    return String(task.progress.current);
  }
  if (task.aggregate.kind === "ratio") {
    const percent = Math.round(task.aggregate.ratio * 100);
    const suffix = task.aggregate.overrun ? "+" : "";
    const count =
      !task.aggregateFromChildren && task.progress.kind === "determinate"
        ? `${task.progress.current}/${task.progress.total} `
        : "";
    return `${progressBar(task.aggregate.ratio, task.aggregate.overrun, theme)} ${count}${percent}${suffix}%`;
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
