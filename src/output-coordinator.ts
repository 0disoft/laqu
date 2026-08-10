import type { Frame, JsonSerialization, Renderer } from "./renderer.js";
import type { RuntimeSnapshot } from "./task-store.js";
import type { StreamTarget } from "./types.js";

type JsonEvents = Extract<Frame, { readonly kind: "json" }>["events"];

interface PendingLiveFrame {
  readonly scrollbackLines: string[];
  lines: readonly string[];
}

export type LaquOutputErrorCode =
  | "LAQU_OUTPUT_WRITE_FAILED"
  | "LAQU_OUTPUT_BACKPRESSURE_TIMEOUT"
  | "LAQU_OUTPUT_BACKPRESSURE_UNSUPPORTED"
  | "LAQU_OUTPUT_BUFFER_OVERFLOW";

export class LaquOutputError extends Error {
  override readonly name = "LaquOutputError";

  constructor(
    readonly code: LaquOutputErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class TerminalLease {
  closed = false;
  renderedLineCount = 0;
  cursorHiddenByUs = 0;
  rawModeChangedByUs = false;
  activeBars = 0;
  renderTimer: ReturnType<typeof setTimeout> | undefined;
  partialLineKnownByUs = false;
  lastLiveLines: readonly string[] = [];
}

export class OutputCoordinator {
  readonly lease = new TerminalLease();
  #waitingForDrain = false;
  #drainPromise: Promise<void> | undefined;
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #settleDrain: (() => void) | undefined;
  #jsonArrayStarted = false;
  #jsonArrayNeedsComma = false;
  readonly #pendingFrames: Frame[] = [];
  #pendingHead = 0;
  #pendingLiveFrame: PendingLiveFrame | undefined;
  #pendingLiveFrameCount = 0;
  #pendingCount = 0;
  #outputError: LaquOutputError | undefined;

  constructor(
    private readonly target: StreamTarget,
    private readonly renderer: Renderer,
    private readonly live: boolean,
    private readonly jsonSerialization: JsonSerialization = "none",
    private readonly backpressureTimeoutMs = 1_000,
    private readonly maxPendingFrames = 4_096,
  ) {}

  render(snapshot: RuntimeSnapshot): void {
    if (this.lease.closed || this.#outputError !== undefined) {
      return;
    }
    this.writeFrame(this.renderer.render(snapshot));
  }

  writeFrame(frame: Frame): void {
    if (frame.kind === "none" || this.lease.closed || this.#outputError !== undefined) {
      return;
    }
    if (this.#waitingForDrain) {
      this.#enqueuePending(frame);
      return;
    }
    this.#writeNow(frame);
  }

  finalize(snapshot: RuntimeSnapshot): void {
    if (this.lease.closed || this.#outputError !== undefined) {
      return;
    }
    this.writeFrame(this.renderer.finalize?.(snapshot) ?? { kind: "none" });
  }

  async flush(): Promise<void> {
    while (true) {
      this.#throwIfFailed();
      if (this.#drainPromise !== undefined) {
        await this.#drainPromise;
        continue;
      }
      const pending = this.#dequeuePending();
      if (pending === undefined) {
        break;
      }
      this.#writeNow(pending);
    }
    this.#throwIfFailed();
  }

  async close(): Promise<void> {
    if (this.lease.closed) {
      this.#throwIfFailed();
      return;
    }

    let closeFailure: unknown;
    try {
      if (this.#outputError === undefined) {
        try {
          await this.flush();
        } catch (error) {
          closeFailure = error;
        }
      }
      if (
        closeFailure === undefined &&
        this.#outputError === undefined &&
        this.jsonSerialization === "array"
      ) {
        this.#writeRaw(this.#jsonArrayStarted ? "]\n" : "[]\n");
        try {
          await this.flush();
        } catch (error) {
          closeFailure = error;
        }
      }
      if (this.live) {
        const cursor = this.#showCursor();
        const cleanup =
          this.lease.renderedLineCount > 0
            ? `${cursor}\u001b[0m\n`
            : cursor.length > 0
              ? `${cursor}\u001b[0m`
              : "";
        if (closeFailure === undefined && this.#outputError === undefined) {
          this.#writeRaw(cleanup);
          try {
            await this.flush();
          } catch (error) {
            closeFailure = error;
            this.#writeBestEffortRaw(cleanup);
          }
        } else {
          this.#writeBestEffortRaw(cleanup);
        }
      }
    } finally {
      this.#settleDrain?.();
      this.lease.closed = true;
      this.lease.renderedLineCount = 0;
      this.lease.cursorHiddenByUs = 0;
      this.lease.activeBars = 0;
      this.lease.partialLineKnownByUs = false;
      this.lease.lastLiveLines = [];
      this.#jsonArrayStarted = false;
      this.#jsonArrayNeedsComma = false;
      this.#clearPending();
    }

    if (closeFailure !== undefined) {
      throw closeFailure;
    }
    this.#throwIfFailed();
  }

  #enqueuePending(frame: Frame): void {
    if (this.#pendingCount >= this.maxPendingFrames) {
      this.#fail(
        new LaquOutputError(
          "LAQU_OUTPUT_BUFFER_OVERFLOW",
          `status output exceeded ${this.maxPendingFrames} pending frames`,
        ),
      );
      return;
    }
    this.#pendingCount += 1;
    if (this.live && frame.kind === "live") {
      if (this.#pendingLiveFrame === undefined) {
        this.#pendingLiveFrame = {
          scrollbackLines: [...frame.scrollbackLines],
          lines: frame.lines,
        };
      } else {
        for (const line of frame.scrollbackLines) {
          this.#pendingLiveFrame.scrollbackLines.push(line);
        }
        this.#pendingLiveFrame.lines = frame.lines;
      }
      this.#pendingLiveFrameCount += 1;
      return;
    }
    this.#pendingFrames.push(frame);
  }

  #dequeuePending(): Frame | undefined {
    const frame = this.#pendingFrames[this.#pendingHead];
    if (frame !== undefined) {
      this.#pendingHead += 1;
      this.#pendingCount -= 1;
      if (this.#pendingHead === this.#pendingFrames.length) {
        this.#pendingFrames.length = 0;
        this.#pendingHead = 0;
      }
      return frame;
    }
    if (this.#pendingLiveFrame !== undefined) {
      const liveFrame: Frame = { kind: "live", ...this.#pendingLiveFrame };
      this.#pendingLiveFrame = undefined;
      this.#pendingCount -= this.#pendingLiveFrameCount;
      this.#pendingLiveFrameCount = 0;
      return liveFrame;
    }
    return undefined;
  }

  #clearPending(): void {
    this.#pendingFrames.length = 0;
    this.#pendingHead = 0;
    this.#pendingLiveFrame = undefined;
    this.#pendingLiveFrameCount = 0;
    this.#pendingCount = 0;
  }

  #writeNow(frame: Frame): void {
    switch (frame.kind) {
      case "live":
        this.#writeLive(frame.scrollbackLines, frame.lines);
        return;
      case "plain":
        this.#writeRaw(`${frame.lines.join("\n")}\n`);
        return;
      case "json":
        this.#writeJson(frame.events);
        return;
      case "none":
        return;
    }
  }

  #writeJson(events: JsonEvents): void {
    if (events.length === 0) {
      return;
    }
    if (this.jsonSerialization === "array") {
      let chunk = "";
      if (!this.#jsonArrayStarted) {
        chunk += "[";
        this.#jsonArrayStarted = true;
      }
      for (const event of events) {
        chunk += `${this.#jsonArrayNeedsComma ? "," : ""}${JSON.stringify(event)}`;
        this.#jsonArrayNeedsComma = true;
      }
      this.#writeRaw(chunk);
      return;
    }
    this.#writeRaw(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }

  #writeLive(scrollbackLines: readonly string[], lines: readonly string[]): void {
    if (scrollbackLines.length === 0 && sameLines(lines, this.lease.lastLiveLines)) {
      return;
    }
    const cursor = this.#hideCursor();
    const clear = this.lease.renderedLineCount > 0 ? eraseLines(this.lease.renderedLineCount) : "";
    const scrollback = scrollbackLines.length > 0 ? `${scrollbackLines.join("\n")}\n` : "";
    const liveLines = lines.length > 0 ? lines.join("\n") : "";
    const chunk = `${cursor}${clear}${scrollback}${liveLines}\u001b[0m`;
    this.lease.renderedLineCount = lines.length;
    this.lease.partialLineKnownByUs = lines.length > 0;
    this.lease.lastLiveLines = [...lines];
    this.#writeRaw(chunk);
  }

  #hideCursor(): string {
    if (!this.live || this.lease.cursorHiddenByUs > 0) {
      return "";
    }
    this.lease.cursorHiddenByUs += 1;
    return "\u001b[?25l";
  }

  #showCursor(): string {
    if (!this.live || this.lease.cursorHiddenByUs === 0) {
      return "";
    }
    this.lease.cursorHiddenByUs = 0;
    return "\u001b[?25h";
  }

  #writeRaw(chunk: string): void {
    if (chunk.length === 0 || this.lease.closed || this.#outputError !== undefined) {
      return;
    }
    let accepted: boolean;
    try {
      accepted = this.target.write(chunk);
    } catch (error) {
      this.#fail(
        new LaquOutputError("LAQU_OUTPUT_WRITE_FAILED", "status output write failed", {
          cause: error,
        }),
      );
      return;
    }
    if (accepted !== false) {
      return;
    }
    if (this.target.on === undefined || this.target.off === undefined) {
      this.#fail(
        new LaquOutputError(
          "LAQU_OUTPUT_BACKPRESSURE_UNSUPPORTED",
          "status stream returned backpressure without removable drain listeners",
        ),
      );
      return;
    }
    this.#waitForDrain();
  }

  #waitForDrain(): void {
    this.#waitingForDrain = true;
    this.#drainPromise = new Promise((resolve) => {
      const settle = () => {
        if (!this.#waitingForDrain) {
          return;
        }
        if (this.#drainTimer !== undefined) {
          clearTimeout(this.#drainTimer);
          this.#drainTimer = undefined;
        }
        this.target.off?.("drain", onDrain);
        this.target.off?.("error", onError);
        this.target.off?.("close", onClose);
        this.target.off?.("finish", onFinish);
        this.#waitingForDrain = false;
        this.#drainPromise = undefined;
        this.#settleDrain = undefined;
        resolve();
      };
      const onDrain = () => settle();
      const onError = (error: unknown) => {
        this.#storeError(
          new LaquOutputError("LAQU_OUTPUT_WRITE_FAILED", "status stream emitted an error", {
            cause: error,
          }),
        );
        settle();
      };
      const onClose = () => {
        this.#storeError(
          new LaquOutputError("LAQU_OUTPUT_WRITE_FAILED", "status stream closed before drain"),
        );
        settle();
      };
      const onFinish = () => {
        this.#storeError(
          new LaquOutputError("LAQU_OUTPUT_WRITE_FAILED", "status stream finished before drain"),
        );
        settle();
      };
      this.#settleDrain = settle;
      this.target.on?.("drain", onDrain);
      this.target.on?.("error", onError);
      this.target.on?.("close", onClose);
      this.target.on?.("finish", onFinish);
      this.#drainTimer = setTimeout(() => {
        this.#storeError(
          new LaquOutputError(
            "LAQU_OUTPUT_BACKPRESSURE_TIMEOUT",
            `status stream did not drain within ${this.backpressureTimeoutMs}ms`,
          ),
        );
        settle();
      }, this.backpressureTimeoutMs);
    });
  }

  #writeBestEffortRaw(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    try {
      this.target.write(chunk);
    } catch {
      // The original output failure remains authoritative.
    }
  }

  #fail(error: LaquOutputError): void {
    this.#storeError(error);
    this.#settleDrain?.();
  }

  #storeError(error: LaquOutputError): void {
    this.#outputError ??= error;
    this.#clearPending();
  }

  #throwIfFailed(): void {
    if (this.#outputError !== undefined) {
      throw this.#outputError;
    }
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function eraseLines(count: number): string {
  let output = "\r\u001b[2K";
  for (let index = 1; index < count; index += 1) {
    output += "\u001b[1A\r\u001b[2K";
  }
  return output;
}
