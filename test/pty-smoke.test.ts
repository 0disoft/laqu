import { strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test(
  "real PTY resize redraws against the new terminal width",
  { skip: process.platform === "win32" ? "ConPTY harness is not available" : false },
  () => {
    const harness = resolve("test/fixtures/pty-harness.py");
    const child = resolve("test/fixtures/pty-child.mjs");
    const result = spawnSync("python3", [harness, process.execPath, child], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });

    strictEqual(result.error, undefined, result.error?.message);
    strictEqual(result.status, 0, result.stderr);
    const encoded = JSON.parse(result.stdout) as {
      readonly initial: string;
      readonly resized: string;
    };
    const output = {
      initial: Buffer.from(encoded.initial, "base64").toString("utf8"),
      resized: Buffer.from(encoded.resized, "base64").toString("utf8"),
    };

    strictEqual(output.initial.includes("pty-resize-task"), true);
    strictEqual(output.resized.includes("…"), true);
    strictEqual(output.resized.includes("message-after-terminal-resize"), false);
    strictEqual(output.initial.includes("\u001b[?25l"), true);
    strictEqual(output.resized.includes("\u001b[2K"), true);
  },
);
