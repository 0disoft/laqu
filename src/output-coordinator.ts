import type { Frame, Renderer } from "./renderer.js";
import type { RuntimeSnapshot } from "./task-store.js";
import type { StreamTarget } from "./types.js";

export class TerminalLease {
  closed = false;
  renderedLineCount = 0;
  cursorHiddenByUs = 0;
  rawModeChangedByUs = false;
  activeBars = 0;
  renderTimer: ReturnType<typeof setTimeout> | undefined;
  pendingFrame: Frame | undefined;
  partialLineKnownByUs = false;
}

export class OutputCoordinator {
  readonly lease = new TerminalLease();
  #waitingForDrain = false;
  #drainPromise: Promise<void> | undefined;

  constructor(
    private readonly target: StreamTarget,
    private readonly renderer: Renderer,
    private readonly live: boolean,
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
      this.lease.pendingFrame = frame;
      return;
    }
    this.#writeNow(frame);
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
    if (this.live && this.lease.renderedLineCount > 0) {
      this.#writeRaw("\u001b[0m\n");
    } else {
      this.#writeRaw("\u001b[0m");
    }
    this.lease.closed = true;
    this.lease.renderedLineCount = 0;
    this.lease.cursorHiddenByUs = 0;
    this.lease.activeBars = 0;
    this.lease.pendingFrame = undefined;
    this.lease.partialLineKnownByUs = false;
  }

  #writeNow(frame: Frame): void {
    switch (frame.kind) {
      case "live":
        this.#writeLive(frame.lines);
        return;
      case "plain":
        this.#writeRaw(`${frame.lines.join("\n")}\n`);
        return;
      case "json":
        this.#writeRaw(`${frame.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
        return;
      case "none":
        return;
    }
  }

  #writeLive(lines: readonly string[]): void {
    const clear = this.lease.renderedLineCount > 0 ? eraseLines(this.lease.renderedLineCount) : "";
    const chunk = `${clear}${lines.join("\n")}\u001b[0m`;
    this.lease.renderedLineCount = lines.length;
    this.lease.partialLineKnownByUs = lines.length > 0;
    this.#writeRaw(chunk);
  }

  #writeRaw(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    const accepted = this.target.write(chunk);
    if (accepted) {
      return;
    }
    this.#waitingForDrain = true;
    this.#drainPromise = new Promise((resolve) => {
      const onDrain = () => {
        this.target.off?.("drain", onDrain);
        this.#waitingForDrain = false;
        this.#drainPromise = undefined;
        const pending = this.lease.pendingFrame;
        this.lease.pendingFrame = undefined;
        if (pending !== undefined) {
          this.#writeNow(pending);
        }
        resolve();
      };
      this.target.on?.("drain", onDrain);
    });
  }
}

function eraseLines(count: number): string {
  let output = "\r\u001b[2K";
  for (let index = 1; index < count; index += 1) {
    output += "\u001b[1A\r\u001b[2K";
  }
  return output;
}
