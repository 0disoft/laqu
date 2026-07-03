export type OutputFormat = "human" | "json" | "ndjson";
export type StreamCapability = "tty" | "ci" | "pipe" | "dumb";
export type ChannelRole = "data" | "status" | "log";
export type ProgressPolicy = "auto" | "always" | "never" | "plain" | "jsonl" | "silent";

export interface StreamTarget {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(chunk: string): boolean;
  on?(event: "drain", listener: () => void): unknown;
  off?(event: "drain", listener: () => void): unknown;
}

export interface RuntimeEnvironment {
  readonly [key: string]: string | undefined;
  readonly CI?: string | undefined;
  readonly TERM?: string | undefined;
  readonly NO_COLOR?: string | undefined;
  readonly FORCE_COLOR?: string | undefined;
}

export interface RuntimeOptions {
  readonly stdout?: StreamTarget;
  readonly stderr?: StreamTarget;
  readonly statusStream?: StreamTarget;
  readonly format?: OutputFormat;
  readonly streamCapability?: StreamCapability;
  readonly progressPolicy?: ProgressPolicy;
  readonly env?: RuntimeEnvironment;
  readonly maxRows?: number;
  readonly theme?: ThemeInput;
}

export interface TaskOptions {
  readonly total?: number;
  readonly completed?: number;
  readonly ratio?: number;
  readonly weight?: number;
  readonly message?: string;
  readonly detail?: string;
  readonly signal?: AbortSignal;
}

export interface TaskHandle {
  readonly id: string;
  setTotal(total: number): void;
  setCompleted(completed: number): void;
  advance(delta: number): void;
  setRatio(ratio: number): void;
  setPercent(percent: number): void;
  setIndeterminate(message?: string): void;
  setMessage(message: string): void;
  setDetail(detail: string): void;
  succeed(message?: string): void;
  fail(error?: unknown): void;
  cancel(message?: string): void;
  child(title: string, options?: TaskOptions): TaskHandle;
}

export interface ProgressRuntime {
  task<T>(title: string, callback: (task: TaskHandle) => T | Promise<T>): Promise<Awaited<T>>;
  task<T>(
    title: string,
    options: TaskOptions,
    callback: (task: TaskHandle) => T | Promise<T>,
  ): Promise<Awaited<T>>;
  createTask(title: string, options?: TaskOptions): TaskHandle;
  log(message: string): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface ThemeTokens {
  readonly successSymbol: string;
  readonly failSymbol: string;
  readonly cancelSymbol: string;
  readonly runningSymbol: string;
  readonly pendingSymbol: string;
  readonly progressComplete: string;
  readonly progressIncomplete: string;
  readonly progressIndeterminate: string;
  readonly indent: string;
  readonly gap: string;
  readonly overflowMarker: string;
}

export type ThemeInput = Partial<ThemeTokens> & {
  readonly useColor?: boolean;
};
