import { AsyncLocalStorage } from "node:async_hooks";

import { OutputCoordinator } from "./output-coordinator.js";
import { chooseRenderer } from "./renderer.js";
import {
  advanceProgress,
  ratioProgress,
  setCompletedProgress,
  setTotalProgress,
  type ProgressState,
  TaskStore,
} from "./task-store.js";
import { compileTheme } from "./theme.js";
import type {
  ProgressPolicy,
  ProgressRuntime,
  RuntimeEnvironment,
  RuntimeOptions,
  StreamCapability,
  StreamTarget,
  TaskHandle,
  TaskOptions,
} from "./types.js";

const defaultFlushHz = 15;
const liveStreamLeases = new WeakSet<StreamTarget>();

interface LiveStreamLease {
  release(): void;
}

export function createLaqu(options: RuntimeOptions = {}): ProgressRuntime {
  return createProgressRuntime(options);
}

export function createProgressRuntime(options: RuntimeOptions = {}): ProgressRuntime {
  assertRuntimeOptions(options);
  const stderr = options.statusStream ?? options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const capability = options.streamCapability ?? detectCapability(stderr, env);
  const policy = options.progressPolicy ?? "auto";
  const theme = compileTheme({ useColor: defaultUseColor(capability, env), ...options.theme });
  const columns = normalizedColumns(stderr.columns);
  const maxRows = validatedPositiveSafeInteger(options.maxRows ?? 12, "maxRows");
  const rendererOptions = {
    format: options.format ?? "human",
    policy,
    capability,
    theme,
    columns,
    maxRows,
  };
  const initialDecision = chooseRenderer(rendererOptions);
  const liveStreamLease = initialDecision.live ? acquireLiveStreamLease(stderr) : undefined;
  const decision =
    initialDecision.live && liveStreamLease === undefined
      ? chooseRenderer({ ...rendererOptions, policy: "plain" })
      : initialDecision;

  const store = new TaskStore({
    maxLogs: options.retention?.maxLogs,
    maxTerminalTasks: options.retention?.maxTerminalTasks,
  });
  const coordinator = new OutputCoordinator(
    stderr,
    decision.renderer,
    decision.live,
    decision.jsonSerialization,
  );
  const runtime = new LaquRuntime(store, coordinator, policy, liveStreamLease);
  if (options.manageProcessLifecycle === true) {
    runtime.manageProcessLifecycle();
  }
  return runtime;
}

class LaquRuntime implements ProgressRuntime {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #dirty = false;
  #closing = false;
  #closed = false;
  #processLifecycle: ProcessLifecycleLease | undefined;
  readonly #handles = new Set<StoreTaskHandle>();
  readonly #taskCloseContext = new AsyncLocalStorage<StoreTaskHandle>();
  #activeScopedTasks = 0;
  #closeRequestedByScopedTask = false;
  #scopedTasksDrained: Promise<void> | undefined;
  #resolveScopedTasksDrained: (() => void) | undefined;

  constructor(
    private readonly store: TaskStore,
    private readonly coordinator: OutputCoordinator,
    private readonly policy: ProgressPolicy,
    private readonly liveStreamLease: LiveStreamLease | undefined,
  ) {}

  async task<T>(title: string, callback: (task: TaskHandle) => T | Promise<T>): Promise<Awaited<T>>;
  async task<T>(
    title: string,
    options: TaskOptions,
    callback: (task: TaskHandle) => T | Promise<T>,
  ): Promise<Awaited<T>>;
  async task<T>(
    title: string,
    optionsOrCallback: TaskOptions | ((task: TaskHandle) => T | Promise<T>),
    maybeCallback?: (task: TaskHandle) => T | Promise<T>,
  ): Promise<Awaited<T>> {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (callback === undefined) {
      throw new TypeError("task callback is required");
    }

    const handle = this.#createRootHandle(title, options);
    this.#activeScopedTasks += 1;
    try {
      const result = await this.#taskCloseContext.run(handle, () => callback(handle));
      if (this.#acceptsMutations()) {
        handle.succeed();
      }
      return result;
    } catch (error) {
      if (this.#acceptsMutations()) {
        if (options.signal?.aborted === true) {
          this.store.forceTerminalUpdate(handle.id, { status: "cancelled", message: "aborted" });
        } else {
          const message = unknownToMessage(error);
          this.store.forceTerminalUpdate(handle.id, { status: "failed", message });
        }
        this.markDirty(true);
      }
      throw error;
    } finally {
      handle.dispose();
      this.#activeScopedTasks -= 1;
      if (this.#activeScopedTasks === 0) {
        this.#resolveScopedTasksDrained?.();
        this.#resolveScopedTasksDrained = undefined;
        this.#scopedTasksDrained = undefined;
      }
      await this.flush();
      if (this.#shouldRunDeferredScopedClose()) {
        this.#closeRequestedByScopedTask = false;
        await this.close();
      }
    }
  }

  createTask(title: string, options: TaskOptions = {}): TaskHandle {
    return this.#createRootHandle(title, options);
  }

  log(message: string): void {
    this.#assertAcceptsMutations();
    this.store.addLog(message);
    this.markDirty(true);
  }

  async flush(): Promise<void> {
    this.#flushPromise ??= this.#flushOnce().finally(() => {
      this.#flushPromise = undefined;
    });
    await this.#flushPromise;
  }

  async close(): Promise<void> {
    if (this.#shouldDeferScopedClose()) {
      this.#closeRequestedByScopedTask = true;
      await this.flush();
      return;
    }
    this.#closePromise ??= this.#closeAfterScopedTasks();
    await this.#closePromise;
  }

  async #closeAfterScopedTasks(): Promise<void> {
    if (this.#activeScopedTasks > 0) {
      this.#scopedTasksDrained ??= new Promise<void>((resolve) => {
        this.#resolveScopedTasksDrained = resolve;
      });
      await this.#scopedTasksDrained;
    }
    await this.#closeOnce();
  }

  manageProcessLifecycle(): void {
    this.#processLifecycle ??= new ProcessLifecycleLease(() => {
      return this.close();
    });
  }

  async #flushOnce(): Promise<void> {
    do {
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer);
        this.#timer = undefined;
      }
      this.#dirty = false;
      this.coordinator.render(this.store.snapshot());
      await this.coordinator.flush();
    } while (this.#dirty && !this.#closed && this.policy !== "silent" && this.policy !== "never");
  }

  async #closeOnce(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closing = true;
    this.#processLifecycle?.dispose();
    this.#processLifecycle = undefined;
    for (const handle of this.#handles) {
      handle.dispose();
    }
    try {
      await this.flush();
      this.#closed = true;
      this.coordinator.finalize(this.store.snapshot());
      await this.coordinator.close();
    } finally {
      this.liveStreamLease?.release();
    }
  }

  private markDirty(immediate = false): void {
    if (this.#closing || this.#closed || this.policy === "silent" || this.policy === "never") {
      return;
    }
    this.#dirty = true;
    if (immediate) {
      this.#flushInBackground();
      return;
    }
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        if (this.#dirty) {
          this.#flushInBackground();
        }
      },
      Math.round(1000 / defaultFlushHz),
    );
  }

  #flushInBackground(): void {
    void this.flush().catch(() => {
      this.#dirty = false;
    });
  }

  #shouldDeferScopedClose(): boolean {
    return (
      this.#taskCloseContext.getStore() !== undefined &&
      this.#activeScopedTasks > 0 &&
      !this.#closing &&
      !this.#closed
    );
  }

  #shouldRunDeferredScopedClose(): boolean {
    return (
      this.#closeRequestedByScopedTask &&
      this.#activeScopedTasks === 0 &&
      !this.#closing &&
      !this.#closed
    );
  }

  #acceptsMutations(): boolean {
    return !this.#closing && !this.#closed;
  }

  #assertAcceptsMutations(): void {
    if (!this.#acceptsMutations()) {
      throw new Error("Laqu runtime is closing");
    }
  }

  #createRootHandle(title: string, options: TaskOptions): StoreTaskHandle {
    this.#assertAcceptsMutations();
    const id = this.store.createTask(title, options);
    const handle = this.#createHandle(id);
    handle.bindSignal(options.signal);
    this.markDirty(true);
    return handle;
  }

  #createHandle(id: string): StoreTaskHandle {
    let handle: StoreTaskHandle;
    handle = new StoreTaskHandle(
      id,
      this.store,
      (immediate) => this.markDirty(immediate),
      () => this.#assertAcceptsMutations(),
      (parentId, title, options) => this.#createChildHandle(parentId, title, options),
      () => {
        this.#handles.delete(handle);
      },
    );
    this.#handles.add(handle);
    return handle;
  }

  #createChildHandle(parentId: string, title: string, options: TaskOptions): StoreTaskHandle {
    this.#assertAcceptsMutations();
    const id = this.store.createTask(title, options, parentId);
    const handle = this.#createHandle(id);
    handle.bindSignal(options.signal);
    this.markDirty(true);
    return handle;
  }
}

class ProcessLifecycleLease {
  readonly #onSignal: NodeJS.SignalsListener;
  readonly #onException: NodeJS.UncaughtExceptionListener;
  readonly #onRejection: NodeJS.UnhandledRejectionListener;

  constructor(cleanup: () => Promise<void>) {
    this.#onSignal = (signal) => {
      void cleanup().finally(() => {
        process.kill(process.pid, signal);
      });
    };
    this.#onException = (error) => {
      process.exitCode = 1;
      void cleanup().finally(() => {
        setImmediate(() => {
          throw error;
        });
      });
    };
    this.#onRejection = (reason) => {
      process.exitCode = 1;
      void cleanup().finally(() => {
        setImmediate(() => {
          throw unknownToRejectionError(reason);
        });
      });
    };
    process.once("SIGINT", this.#onSignal);
    process.once("SIGTERM", this.#onSignal);
    process.once("uncaughtException", this.#onException);
    process.once("unhandledRejection", this.#onRejection);
  }

  dispose(): void {
    process.off("SIGINT", this.#onSignal);
    process.off("SIGTERM", this.#onSignal);
    process.off("uncaughtException", this.#onException);
    process.off("unhandledRejection", this.#onRejection);
  }
}

class StoreTaskHandle implements TaskHandle {
  #abortCleanup: (() => void) | undefined;

  constructor(
    readonly id: string,
    private readonly store: TaskStore,
    private readonly onChange: (immediate: boolean) => void,
    private readonly assertWritable: () => void,
    private readonly createChildHandle: (
      parentId: string,
      title: string,
      options: TaskOptions,
    ) => TaskHandle,
    private readonly onDispose: () => void,
  ) {}

  bindSignal(signal: AbortSignal | undefined): void {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      this.cancel("aborted");
      return;
    }
    const onAbort = () => this.cancel("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    this.#abortCleanup = () => signal.removeEventListener("abort", onAbort);
  }

  dispose(): void {
    this.#disposeAbortCleanup();
    this.onDispose();
  }

  setTotal(total: number): void {
    this.assertWritable();
    this.store.update(this.id, {
      progress: setTotalProgress(total, currentProgressValue(this.store.getProgress(this.id))),
    });
    this.onChange(false);
  }

  setCompleted(completed: number): void {
    this.assertWritable();
    this.store.update(this.id, {
      progress: setCompletedProgress(completed, this.store.getProgress(this.id)),
    });
    this.onChange(false);
  }

  advance(delta: number): void {
    this.assertWritable();
    this.store.update(this.id, {
      progress: advanceProgress(delta, this.store.getProgress(this.id)),
    });
    this.onChange(false);
  }

  setRatio(ratio: number): void {
    this.assertWritable();
    this.store.update(this.id, { progress: ratioProgress(ratio) });
    this.onChange(false);
  }

  setPercent(percent: number): void {
    this.setRatio(percent / 100);
  }

  setIndeterminate(message?: string): void {
    this.assertWritable();
    this.store.update(this.id, {
      progress: { kind: "indeterminate" },
      ...(message === undefined ? {} : { message }),
    });
    this.onChange(false);
  }

  setMessage(message: string): void {
    this.assertWritable();
    this.store.update(this.id, { message });
    this.onChange(false);
  }

  setDetail(detail: string): void {
    this.assertWritable();
    this.store.update(this.id, { detail });
    this.onChange(false);
  }

  succeed(message?: string): void {
    this.assertWritable();
    this.store.update(this.id, {
      status: "succeeded",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  fail(error?: unknown): void {
    this.assertWritable();
    const message = unknownToMessage(error);
    this.store.update(this.id, {
      status: "failed",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  cancel(message?: string): void {
    this.assertWritable();
    this.store.update(this.id, {
      status: "cancelled",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  skip(message?: string): void {
    this.assertWritable();
    this.store.update(this.id, {
      status: "skipped",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  child(title: string, options: TaskOptions = {}): TaskHandle {
    this.assertWritable();
    return this.createChildHandle(this.id, title, options);
  }

  #disposeAbortCleanup(): void {
    this.#abortCleanup?.();
    this.#abortCleanup = undefined;
  }
}

function detectCapability(stream: StreamTarget, env: RuntimeEnvironment): StreamCapability {
  if (env.CI !== undefined) {
    return "ci";
  }
  if (env.TERM === "dumb") {
    return "dumb";
  }
  return stream.isTTY === true ? "tty" : "pipe";
}

function defaultUseColor(capability: StreamCapability, env: RuntimeEnvironment): boolean {
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  if (env.FORCE_COLOR === "0") {
    return false;
  }
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") {
    return true;
  }
  return capability === "tty";
}

function currentProgressValue(progress: ProgressState): number {
  switch (progress.kind) {
    case "counter":
    case "determinate":
      return progress.current;
    case "indeterminate":
    case "none":
    case "ratio":
      return 0;
  }
}

function normalizedColumns(columns: number | undefined): number {
  if (typeof columns === "number" && Number.isSafeInteger(columns) && columns > 0) {
    return columns;
  }
  return 80;
}

function assertRuntimeOptions(options: RuntimeOptions): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("runtime options must be an object");
  }
  assertStreamTarget(options.stdout, "stdout");
  assertStreamTarget(options.stderr, "stderr");
  assertStreamTarget(options.statusStream, "statusStream");
  assertOutputFormat(options.format);
  assertStreamCapability(options.streamCapability);
  assertProgressPolicy(options.progressPolicy);
  if (
    options.retention !== undefined &&
    (typeof options.retention !== "object" ||
      options.retention === null ||
      Array.isArray(options.retention))
  ) {
    throw new TypeError("retention must be an object");
  }
}

function assertStreamTarget(value: StreamTarget | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!hasCallableProperty(value, "write")) {
    throw new TypeError(`${name} must be a writable stream target`);
  }
}

function hasCallableProperty(value: unknown, property: string): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, property) === "function"
  );
}

function assertOutputFormat(format: RuntimeOptions["format"]): void {
  if (format === undefined || format === "human" || format === "json" || format === "ndjson") {
    return;
  }
  throw new TypeError("format must be one of: human, json, ndjson");
}

function assertStreamCapability(capability: RuntimeOptions["streamCapability"]): void {
  if (
    capability === undefined ||
    capability === "tty" ||
    capability === "ci" ||
    capability === "pipe" ||
    capability === "dumb"
  ) {
    return;
  }
  throw new TypeError("streamCapability must be one of: tty, ci, pipe, dumb");
}

function assertProgressPolicy(policy: RuntimeOptions["progressPolicy"]): void {
  if (
    policy === undefined ||
    policy === "auto" ||
    policy === "always" ||
    policy === "never" ||
    policy === "plain" ||
    policy === "jsonl" ||
    policy === "silent"
  ) {
    return;
  }
  throw new TypeError("progressPolicy must be one of: auto, always, never, plain, jsonl, silent");
}

function validatedPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a safe positive integer`);
  }
  return value;
}

function unknownToMessage(error: unknown): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (error instanceof Error) {
    try {
      return typeof error.message === "string" ? error.message : "Error";
    } catch {
      return "Error";
    }
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === null) {
    return "Non-Error thrown";
  }
  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint" ||
    typeof error === "symbol"
  ) {
    return String(error);
  }
  return "Non-Error thrown";
}

export function unknownToRejectionError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const message = unknownToMessage(reason);
  return new Error(
    message === undefined
      ? "Unhandled promise rejection"
      : `Unhandled promise rejection: ${message}`,
    { cause: reason },
  );
}

function acquireLiveStreamLease(stream: StreamTarget): LiveStreamLease | undefined {
  if (liveStreamLeases.has(stream)) {
    return undefined;
  }
  liveStreamLeases.add(stream);
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      liveStreamLeases.delete(stream);
    },
  };
}
