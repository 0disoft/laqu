import type { Frame, JsonSerialization, Renderer } from "./renderer.js";
import type { RuntimeSnapshot } from "./task-store.js";
import type { StreamTarget } from "./types.js";

type JsonEvents = Extract<Frame, { readonly kind: "json" }>["events"];

export class TerminalLease {
  closed = false;
  renderedLineCount = 0;
  cursorHiddenByUs = 0;
  rawModeChangedByUs = false;
  activeBars = 0;
  renderTimer: ReturnType<typeof setTimeout> | undefined;
  pendingFrame: Frame | undefined;
  partialLineKnownByUs = false;
  lastLiveLines: readonly string[] = [];
}

export class OutputCoordinator {
  readonly lease = new TerminalLease();
  #waitingForDrain = false;
  #drainPromise: Promise<void> | undefined;
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #jsonArrayStarted = false;
  #jsonArrayNeedsComma = false;

  constructor(
    private readonly target: StreamTarget,
    private readonly renderer: Renderer,
    private readonly live: boolean,
    private readonly jsonSerialization: JsonSerialization = "none",
    private readonly backpressureTimeoutMs = 1_000,
  ) {}

  render(snapshot: RuntimeSnapshot): void {
    if (this.lease.closed) {
      return;
    }
    this.writeFrame(this.renderer.render(snapshot));
  }

  writeFrame(frame: Frame): void {
    if (frame.kind === "none") {
      return;
    }
    if (this.#waitingForDrain) {
      this.lease.pendingFrame = mergePendingFrame(this.lease.pendingFrame, frame);
      return;
    }
    this.#writeNow(frame);
  }

  finalize(snapshot: RuntimeSnapshot): void {
    if (this.lease.closed) {
      return;
    }
    this.writeFrame(this.renderer.finalize?.(snapshot) ?? { kind: "none" });
  }

  async flush(): Promise<void> {
    if (this.#drainPromise !== undefined) {
      await this.#drainPromise;
    }
    const pending = this.lease.pendingFrame;
    this.lease.pendingFrame = undefined;
    if (pending !== undefined) {
      this.#writeNow(pending);
    }
    if (this.#drainPromise !== undefined) {
      await this.#drainPromise;
    }
  }

  async close(): Promise<void> {
    if (this.lease.closed) {
      return;
    }
    await this.flush();
    if (this.jsonSerialization === "array") {
      this.#writeRaw(this.#jsonArrayStarted ? "]\n" : "[]\n");
      await this.flush();
    }
    if (this.live) {
      const cursor = this.#showCursor();
      if (this.lease.renderedLineCount > 0) {
        this.#writeRaw(`${cursor}\u001b[0m\n`);
      } else if (cursor.length > 0) {
        this.#writeRaw(`${cursor}\u001b[0m`);
      }
    }
    this.lease.closed = true;
    this.lease.renderedLineCount = 0;
    this.lease.cursorHiddenByUs = 0;
    this.lease.activeBars = 0;
    this.lease.pendingFrame = undefined;
    this.lease.partialLineKnownByUs = false;
    this.lease.lastLiveLines = [];
    this.#jsonArrayStarted = false;
    this.#jsonArrayNeedsComma = false;
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
    if (chunk.length === 0) {
      return;
    }
    const accepted = this.target.write(chunk);
    if (accepted !== false) {
      return;
    }
    if (this.target.on === undefined || this.target.off === undefined) {
      return;
    }
    this.#waitingForDrain = true;
    this.#drainPromise = new Promise((resolve) => {
      const settle = (replayPending: boolean) => {
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
        const pending = this.lease.pendingFrame;
        this.lease.pendingFrame = undefined;
        if (replayPending && pending !== undefined) {
          this.#writeNow(pending);
        }
        resolve();
      };
      const onDrain = () => settle(true);
      const onError = () => settle(false);
      const onClose = () => settle(false);
      const onFinish = () => settle(false);
      this.target.on?.("drain", onDrain);
      this.target.on?.("error", onError);
      this.target.on?.("close", onClose);
      this.target.on?.("finish", onFinish);
      this.#drainTimer = setTimeout(() => settle(false), this.backpressureTimeoutMs);
    });
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function mergePendingFrame(previous: Frame | undefined, next: Frame): Frame {
  if (previous?.kind === "json" && next.kind === "json") {
    return { kind: "json", events: [...previous.events, ...next.events] };
  }
  return next;
}

function eraseLines(count: number): string {
  let output = "\r\u001b[2K";
  for (let index = 1; index < count; index += 1) {
    output += "\u001b[1A\r\u001b[2K";
  }
  return output;
}
