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
const fatalShutdownTimeoutMs = 250;
const liveStreamLeases = new WeakSet<StreamTarget>();

type RuntimeState = "open" | "draining" | "finalizing" | "closed";

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
  const configuredMaxRows = validatedPositiveSafeInteger(options.maxRows ?? 12, "maxRows");
  const rendererOptions = {
    format: options.format ?? "human",
    policy,
    capability,
    theme,
    columns: () => normalizedColumns(stderr.columns),
    maxRows: () => normalizedRows(stderr.rows, configuredMaxRows),
  };
  const store = new TaskStore({
    maxLogs: options.retention?.maxLogs,
    maxTerminalTasks: options.retention?.maxTerminalTasks,
  });
  const initialDecision = chooseRenderer(rendererOptions);
  const liveStreamLease = initialDecision.live ? acquireLiveStreamLease(stderr) : undefined;
  const decision =
    initialDecision.live && liveStreamLease === undefined
      ? chooseRenderer({ ...rendererOptions, policy: "plain" })
      : initialDecision;

  let runtime: LaquRuntime | undefined;
  try {
    const coordinator = new OutputCoordinator(
      stderr,
      decision.renderer,
      decision.live,
      decision.jsonSerialization,
    );
    runtime = new LaquRuntime(
      store,
      coordinator,
      policy,
      liveStreamLease,
      decision.live ? stderr : undefined,
    );
    if (options.manageProcessLifecycle === true) {
      runtime.manageProcessLifecycle();
    }
    return runtime;
  } catch (error) {
    runtime?.disposeInfrastructure();
    if (runtime === undefined) {
      liveStreamLease?.release();
    }
    throw error;
  }
}

class LaquRuntime implements ProgressRuntime {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushPromise: Promise<void> | undefined;
  #gracefulClosePromise: Promise<void> | undefined;
  #finalizePromise: Promise<void> | undefined;
  #dirty = false;
  #state: RuntimeState = "open";
  #processLifecycle: ProcessLifecycleLease | undefined;
  #terminalResizeCleanup: (() => void) | undefined;
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
    resizeTarget: StreamTarget | undefined,
  ) {
    if (resizeTarget !== undefined) {
      this.#terminalResizeCleanup = subscribeToResize(resizeTarget, () => {
        this.coordinator.invalidateLiveLayout(normalizedColumns(resizeTarget.columns));
        this.markDirty(true);
      });
    }
  }

  disposeInfrastructure(): void {
    this.#processLifecycle?.dispose();
    this.#processLifecycle = undefined;
    this.#terminalResizeCleanup?.();
    this.#terminalResizeCleanup = undefined;
    this.liveStreamLease?.release();
  }

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

    const handle = this.#createRootHandle(title, options, true);
    this.#activeScopedTasks += 1;
    try {
      const result = await this.#taskCloseContext.run(handle, () => callback(handle));
      if (this.#acceptsHandleMutation(true)) {
        handle.succeed();
      }
      return result;
    } catch (error) {
      if (this.#acceptsHandleMutation(true)) {
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
      if (this.#closeRequestedByScopedTask && this.#activeScopedTasks === 0) {
        this.#closeRequestedByScopedTask = false;
        await this.#gracefulClosePromise;
      }
    }
  }

  createTask(title: string, options: TaskOptions = {}): TaskHandle {
    return this.#createRootHandle(title, options, false);
  }

  log(message: string): void {
    this.#assertLogWritable();
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
    const calledFromScopedTask = this.#shouldDeferScopedClose();
    this.#beginDraining();
    this.#gracefulClosePromise ??= this.#closeAfterScopedTasks();
    if (calledFromScopedTask) {
      this.#closeRequestedByScopedTask = true;
      await this.flush();
      return;
    }
    await this.#gracefulClosePromise;
  }

  async #closeAfterScopedTasks(): Promise<void> {
    if (this.#activeScopedTasks > 0) {
      this.#scopedTasksDrained ??= new Promise<void>((resolve) => {
        this.#resolveScopedTasksDrained = resolve;
      });
      await this.#scopedTasksDrained;
    }
    await this.#finalize();
  }

  manageProcessLifecycle(): void {
    this.#processLifecycle ??= new ProcessLifecycleLease(() => {
      return this.#closeForProcessTermination();
    });
  }

  async #closeForProcessTermination(): Promise<void> {
    this.#beginDraining();
    await waitForSettlement(this.#finalize(), fatalShutdownTimeoutMs);
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
    } while (
      this.#dirty &&
      this.#state !== "closed" &&
      this.policy !== "silent" &&
      this.policy !== "never"
    );
  }

  #finalize(): Promise<void> {
    this.#finalizePromise ??= this.#finalizeOnce();
    return this.#finalizePromise;
  }

  async #finalizeOnce(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "finalizing";
    this.#processLifecycle?.dispose();
    this.#processLifecycle = undefined;
    for (const handle of this.#handles) {
      handle.forceCancel();
    }
    let outputFailure: unknown;
    try {
      try {
        await this.flush();
      } catch (error) {
        outputFailure = error;
      }
      try {
        this.coordinator.finalize(this.store.snapshot());
      } catch (error) {
        outputFailure ??= error;
      }
      try {
        await this.coordinator.close();
      } catch (error) {
        outputFailure ??= error;
      }
      if (outputFailure !== undefined) {
        throw outputFailure;
      }
    } finally {
      this.#state = "closed";
      this.disposeInfrastructure();
    }
  }

  private markDirty(immediate = false): void {
    if (
      this.#state === "finalizing" ||
      this.#state === "closed" ||
      this.policy === "silent" ||
      this.policy === "never"
    ) {
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
      this.#state !== "finalizing" &&
      this.#state !== "closed"
    );
  }

  #beginDraining(): void {
    if (this.#state === "open") {
      this.#state = "draining";
    }
  }

  #acceptsHandleMutation(allowDuringDrain: boolean): boolean {
    return this.#state === "open" || (this.#state === "draining" && allowDuringDrain);
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new Error("Laqu runtime is closing");
    }
  }

  #assertLogWritable(): void {
    if (
      this.#state === "open" ||
      (this.#state === "draining" && this.#taskCloseContext.getStore() !== undefined)
    ) {
      return;
    }
    throw new Error("Laqu runtime is closing");
  }

  #assertHandleWritable(allowDuringDrain: boolean): void {
    if (!this.#acceptsHandleMutation(allowDuringDrain)) {
      throw new Error("Laqu runtime is closing");
    }
  }

  #createRootHandle(
    title: string,
    options: TaskOptions,
    allowDuringDrain: boolean,
  ): StoreTaskHandle {
    this.#assertOpen();
    const id = this.store.createTask(title, options);
    const handle = this.#createHandle(id, allowDuringDrain);
    handle.bindSignal(options.signal);
    this.markDirty(true);
    return handle;
  }

  #createHandle(id: string, allowDuringDrain: boolean): StoreTaskHandle {
    let handle: StoreTaskHandle;
    handle = new StoreTaskHandle(
      id,
      this.store,
      (immediate) => this.markDirty(immediate),
      () => this.#assertHandleWritable(allowDuringDrain),
      (parentId, title, options) =>
        this.#createChildHandle(parentId, title, options, allowDuringDrain),
      () => {
        this.#handles.delete(handle);
      },
    );
    this.#handles.add(handle);
    return handle;
  }

  #createChildHandle(
    parentId: string,
    title: string,
    options: TaskOptions,
    allowDuringDrain: boolean,
  ): StoreTaskHandle {
    this.#assertHandleWritable(allowDuringDrain);
    const id = this.store.createTask(title, options, parentId);
    const handle = this.#createHandle(id, allowDuringDrain);
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
    let terminationStarted = false;
    const runCleanup = (after: () => void) => {
      if (terminationStarted) {
        return;
      }
      terminationStarted = true;
      void cleanup().then(after, after);
    };
    this.#onSignal = (signal) => {
      runCleanup(() => {
        process.kill(process.pid, signal);
      });
    };
    this.#onException = (error) => {
      process.exitCode = 1;
      runCleanup(() => {
        setImmediate(() => {
          throw error;
        });
      });
    };
    this.#onRejection = (reason) => {
      process.exitCode = 1;
      runCleanup(() => {
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
  #disposed = false;

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
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#disposeAbortCleanup();
    this.onDispose();
  }

  forceCancel(): void {
    if (this.#disposed) {
      return;
    }
    this.store.forceTerminalUpdate(this.id, { status: "cancelled" });
    this.dispose();
  }

  setTotal(total: number): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, {
      progress: setTotalProgress(total, currentProgressValue(this.store.getProgress(this.id))),
    });
    this.onChange(false);
  }

  setCompleted(completed: number): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, {
      progress: setCompletedProgress(completed, this.store.getProgress(this.id)),
    });
    this.onChange(false);
  }

  advance(delta: number): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, {
      progress: advanceProgress(delta, this.store.getProgress(this.id)),
    });
    this.onChange(false);
  }

  setRatio(ratio: number): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, { progress: ratioProgress(ratio) });
    this.onChange(false);
  }

  setPercent(percent: number): void {
    this.setRatio(percent / 100);
  }

  setIndeterminate(message?: string): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, {
      progress: { kind: "indeterminate" },
      ...(message === undefined ? {} : { message }),
    });
    this.onChange(false);
  }

  setMessage(message: string): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, { message });
    this.onChange(false);
  }

  setDetail(detail: string): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, { detail });
    this.onChange(false);
  }

  succeed(message?: string): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, {
      status: "succeeded",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  fail(error?: unknown): void {
    if (!this.#canMutate()) {
      return;
    }
    const message = unknownToMessage(error);
    this.store.update(this.id, {
      status: "failed",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  cancel(message?: string): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, {
      status: "cancelled",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  skip(message?: string): void {
    if (!this.#canMutate()) {
      return;
    }
    this.store.update(this.id, {
      status: "skipped",
      ...(message === undefined ? {} : { message }),
    });
    this.dispose();
    this.onChange(true);
  }

  child(title: string, options: TaskOptions = {}): TaskHandle {
    this.assertWritable();
    if (this.#disposed) {
      throw new Error(`Cannot create child task under terminal task: ${this.id}`);
    }
    return this.createChildHandle(this.id, title, options);
  }

  #canMutate(): boolean {
    this.assertWritable();
    return !this.#disposed;
  }

  #disposeAbortCleanup(): void {
    this.#abortCleanup?.();
    this.#abortCleanup = undefined;
  }
}

async function waitForSettlement(promise: Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void promise.then(finish, finish);
  });
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

function normalizedRows(rows: number | undefined, maxRows: number): number {
  if (typeof rows === "number" && Number.isSafeInteger(rows) && rows > 0) {
    return Math.min(rows, maxRows);
  }
  return maxRows;
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

interface ResizeEventTarget {
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

function subscribeToResize(stream: StreamTarget, listener: () => void): (() => void) | undefined {
  const target = stream as unknown as Partial<ResizeEventTarget>;
  if (typeof target.on !== "function" || typeof target.off !== "function") {
    return undefined;
  }
  try {
    target.on("resize", listener);
  } catch {
    return undefined;
  }
  return () => {
    try {
      target.off?.("resize", listener);
    } catch {
      // Resize events are an optional EventEmitter-compatible capability.
    }
  };
}
