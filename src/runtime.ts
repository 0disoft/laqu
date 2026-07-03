import { OutputCoordinator } from "./output-coordinator.js";
import { chooseRenderer } from "./renderer.js";
import {
  advanceProgress,
  ratioProgress,
  setCompletedProgress,
  setTotalProgress,
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

export function createLaqu(options: RuntimeOptions = {}): ProgressRuntime {
  return createProgressRuntime(options);
}

export function createProgressRuntime(options: RuntimeOptions = {}): ProgressRuntime {
  const stderr = options.statusStream ?? options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const capability = options.streamCapability ?? detectCapability(stderr, env);
  const policy = options.progressPolicy ?? "auto";
  const theme = compileTheme({ useColor: env.NO_COLOR === undefined, ...options.theme });
  const decision = chooseRenderer({
    format: options.format ?? "human",
    policy,
    capability,
    theme,
    columns: stderr.columns ?? 80,
    maxRows: options.maxRows ?? 12,
  });

  const store = new TaskStore();
  const coordinator = new OutputCoordinator(stderr, decision.renderer, decision.live);
  const runtime = new LaquRuntime(store, coordinator, policy);
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
  #closed = false;
  #processLifecycle: ProcessLifecycleLease | undefined;

  constructor(
    private readonly store: TaskStore,
    private readonly coordinator: OutputCoordinator,
    private readonly policy: ProgressPolicy,
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

    const handle = this.createTask(title, options);
    const onAbort = () => handle.cancel("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      handle.cancel("aborted");
    }
    try {
      const result = await callback(handle);
      handle.succeed();
      return result;
    } catch (error) {
      if (options.signal?.aborted === true) {
        handle.cancel("aborted");
      } else {
        handle.fail(error);
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      await this.flush();
    }
  }

  createTask(title: string, options: TaskOptions = {}): TaskHandle {
    const id = this.store.createTask(title, options);
    const handle = new StoreTaskHandle(id, this.store, (immediate) => this.markDirty(immediate));
    this.markDirty(true);
    return handle;
  }

  log(message: string): void {
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
    this.#closePromise ??= this.#closeOnce();
    await this.#closePromise;
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
    this.#processLifecycle?.dispose();
    this.#processLifecycle = undefined;
    await this.flush();
    await this.coordinator.close();
    this.#closed = true;
  }

  private markDirty(immediate = false): void {
    if (this.#closed || this.policy === "silent" || this.policy === "never") {
      return;
    }
    this.#dirty = true;
    if (immediate) {
      void this.flush();
      return;
    }
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        if (this.#dirty) {
          void this.flush();
        }
      },
      Math.round(1000 / defaultFlushHz),
    );
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
          throw reason instanceof Error ? reason : new Error("Unhandled promise rejection");
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
  constructor(
    readonly id: string,
    private readonly store: TaskStore,
    private readonly onChange: (immediate: boolean) => void,
  ) {}

  setTotal(total: number): void {
    this.store.update(this.id, { progress: setTotalProgress(total) });
    this.onChange(false);
  }

  setCompleted(completed: number): void {
    this.store.update(this.id, {
      progress: setCompletedProgress(completed, this.store.getProgress(this.id)),
    });
    this.onChange(false);
  }

  advance(delta: number): void {
    this.store.update(this.id, {
      progress: advanceProgress(delta, this.store.getProgress(this.id)),
    });
    this.onChange(false);
  }

  setRatio(ratio: number): void {
    this.store.update(this.id, { progress: ratioProgress(ratio) });
    this.onChange(false);
  }

  setPercent(percent: number): void {
    this.setRatio(percent / 100);
  }

  setIndeterminate(message?: string): void {
    this.store.update(this.id, { progress: { kind: "indeterminate" }, message });
    this.onChange(false);
  }

  setMessage(message: string): void {
    this.store.update(this.id, { message });
    this.onChange(false);
  }

  setDetail(detail: string): void {
    this.store.update(this.id, { detail });
    this.onChange(false);
  }

  succeed(message?: string): void {
    this.store.update(this.id, { status: "succeeded", message });
    this.onChange(true);
  }

  fail(error?: unknown): void {
    const message = error instanceof Error ? error.message : undefined;
    this.store.update(this.id, { status: "failed", message });
    this.onChange(true);
  }

  cancel(message?: string): void {
    this.store.update(this.id, { status: "cancelled", message });
    this.onChange(true);
  }

  child(title: string, options: TaskOptions = {}): TaskHandle {
    const id = this.store.createTask(title, options, this.id);
    this.onChange(true);
    return new StoreTaskHandle(id, this.store, this.onChange);
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
