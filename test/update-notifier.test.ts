import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { createLaqu } from "../src/index.js";
import { packageVersion } from "../src/package-info.js";
import {
  createUpdateNotifier,
  fetchLatestVersion,
  isNewerStableVersion,
  updateNotifier,
} from "../src/update-notifier.js";
import type { RuntimeOptions } from "../src/types.js";
import { stripAnsi } from "../src/width.js";

test("runtime version follows package metadata", () => {
  const metadata = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  strictEqual(packageVersion, metadata.version);
});

test("registry checks bound responses, refuse redirects and settle on failure or timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let mode = "success";
  const stub = context.mock.method(https, "get", (url: string) => {
    strictEqual(url, "https://registry.npmjs.org/@0disoft%2Flaqu/latest");
    const request = Object.assign(new EventEmitter(), {
      destroy(this: EventEmitter) {
        this.emit("close");
        return this;
      },
    });
    queueMicrotask(() => {
      if (mode === "timeout") return;
      if (mode === "network") {
        request.emit("error", new Error("offline"));
        return;
      }
      const response = Object.assign(new EventEmitter(), {
        statusCode: mode === "redirect" ? 302 : 200,
        destroy(this: EventEmitter) {
          this.emit("close");
          return this;
        },
      });
      request.emit("response", response);
      response.emit(
        "data",
        Buffer.from(
          mode === "oversized"
            ? "x".repeat(8193)
            : mode === "invalid"
              ? "bad"
              : '{"version":"2.1.0"}',
        ),
      );
      response.emit("end");
      response.emit("close");
    });
    return request;
  });
  syncBuiltinESMExports();
  context.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
  for (mode of ["success", "network", "redirect", "oversized", "invalid", "timeout"]) {
    const result = fetchLatestVersion(new AbortController().signal);
    await Promise.resolve();
    if (mode === "timeout") context.mock.timers.tick(1500);
    strictEqual(await result, mode === "success" ? "2.1.0" : undefined, mode);
  }
});

test("update comparison uses numeric semver and ignores prerelease latest tags", () => {
  for (const [latest, current, expected] of [
    ["2.1.0", "2.0.0", true],
    ["2.10.0", "2.9.0", true],
    ["3.0.0", "2.9.9", true],
    ["2.0.0", "2.0.0", false],
    ["1.9.9", "2.0.0", false],
    ["2.0.0", "2.0.0-beta.1", true],
    ["3.0.0-beta.1", "2.0.0", false],
    ["2.0.0+build.2", "2.0.0+build.1", false],
    ["02.1.0", "2.0.0", false],
    ["2.0.1-01", "2.0.0", false],
    ["3.0.0\nspoof", "2.0.0", false],
  ] as const)
    strictEqual(isNewerStableVersion(latest, current), expected, `${current} -> ${latest}`);
});

function fixture(cache?: string, latest = "2.1.0") {
  const requests: AbortSignal[] = [];
  const writes: string[] = [];
  const dependencies = {
    currentVersion: "2.0.0",
    now: () => 100_000_000,
    readCache: async () => cache,
    writeCache: async (value: string) => {
      writes.push(value);
    },
    fetchVersion: async (signal: AbortSignal) => {
      requests.push(signal);
      return latest;
    },
  };
  return { dependencies, requests, writes };
}

test("fresh cache avoids the network and announces once across subscribers", async () => {
  const { dependencies, requests } = fixture(
    JSON.stringify({ checkedAt: 99_000_000, latest: "2.1.0" }),
  );
  const notifier = createUpdateNotifier(dependencies);
  const notices: string[] = [];
  const stopOne = notifier.subscribe((version) => notices.push(version));
  const stopTwo = notifier.subscribe((version) => notices.push(version));
  await setImmediate();
  deepStrictEqual(notices, ["2.1.0"]);
  strictEqual(requests.length, 0);
  stopOne();
  stopTwo();
});

test("stale, future, corrupt and oversized caches refresh once and persist the result", async () => {
  for (const cache of [
    undefined,
    "invalid JSON",
    "x".repeat(8193),
    JSON.stringify({ checkedAt: 0, latest: "2.1.0" }),
    JSON.stringify({ checkedAt: 100_000_001, latest: "2.1.0" }),
    JSON.stringify({ checkedAt: 99_000_000, latest: "spoof\nversion" }),
  ]) {
    const { dependencies, requests, writes } = fixture(cache);
    const notifier = createUpdateNotifier(dependencies);
    const notices: string[] = [];
    const stop = notifier.subscribe((version) => notices.push(version));
    notifier.subscribe((version) => notices.push(version));
    await setImmediate();
    strictEqual(requests.length, 1);
    deepStrictEqual(notices, ["2.1.0"]);
    deepStrictEqual(JSON.parse(writes[0]!), { checkedAt: 100_000_000, latest: "2.1.0" });
    stop();
  }
});

test("offline, denied cache storage and invalid responses never fail progress", async () => {
  for (const mode of ["offline", "storage", "invalid", "current"] as const) {
    const { dependencies } = fixture(
      undefined,
      mode === "current" ? "2.0.0" : mode === "invalid" ? "bad" : "2.1.0",
    );
    dependencies.readCache = async () => {
      throw new Error("unreadable");
    };
    dependencies.writeCache = async () => {
      throw new Error("read only");
    };
    if (mode === "offline")
      dependencies.fetchVersion = async () => {
        throw new Error("offline");
      };
    const notices: string[] = [];
    const stop = createUpdateNotifier(dependencies).subscribe((version) => notices.push(version));
    await setImmediate();
    deepStrictEqual(notices, mode === "storage" ? ["2.1.0"] : []);
    stop();
  }
});

test("closing all subscribers aborts a pending request and suppresses late results", async () => {
  const { dependencies } = fixture();
  let signal: AbortSignal | undefined;
  let complete: (value: string) => void = () => {};
  dependencies.fetchVersion = (requestSignal) => {
    signal = requestSignal;
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const notices: string[] = [];
  const notifier = createUpdateNotifier(dependencies);
  const stopOne = notifier.subscribe((version) => notices.push(version));
  const stopTwo = notifier.subscribe((version) => notices.push(version));
  await setImmediate();
  stopOne();
  strictEqual(signal?.aborted, false);
  stopTwo();
  strictEqual(signal?.aborted, true);
  complete("2.1.0");
  await setImmediate();
  deepStrictEqual(notices, []);
});

test("runtime gates checks and routes notices through live scrollback before close", async (context) => {
  throws(
    () => createLaqu({ checkForUpdates: "yes" as unknown as boolean }),
    /checkForUpdates must be a boolean/u,
  );
  let listener: ((version: string) => void) | undefined;
  let starts = 0;
  let stops = 0;
  context.mock.method(updateNotifier, "subscribe", (notify: (version: string) => void) => {
    starts += 1;
    listener = notify;
    return () => {
      stops += 1;
    };
  });
  for (const options of [
    { checkForUpdates: false },
    { format: "json" },
    { format: "ndjson" },
    { progressPolicy: "silent" },
    { progressPolicy: "never" },
    { progressPolicy: "plain" },
    { env: { CI: "1" } },
    { env: { CI: "" } },
    { env: { TERM: "dumb" } },
    { streamCapability: "pipe" },
    { streamCapability: "ci" },
  ] satisfies RuntimeOptions[]) {
    const progress = createLaqu({
      stderr: { isTTY: true, write: () => true },
      env: {},
      checkForUpdates: true,
      ...options,
    });
    await progress.close();
  }
  strictEqual(starts, 0);
  const chunks: string[] = [];
  const stderr = {
    isTTY: true,
    columns: 100,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  };
  const defaultCustom = createLaqu({ stderr, env: {} });
  await defaultCustom.close();
  strictEqual(starts, 0);
  const progress = createLaqu({ stderr, env: {}, checkForUpdates: true });
  progress.createTask("work", { ratio: 0.5 });
  listener?.("99.0.0");
  await progress.flush();
  strictEqual(stripAnsi(chunks.join("")).includes(`laqu ${packageVersion}`), true);
  strictEqual(stripAnsi(chunks.join("")).includes("Update available:"), true);
  await progress.close();
  strictEqual(stops, 1);
  const count = chunks.length;
  listener?.("100.0.0");
  await setImmediate();
  strictEqual(chunks.length, count);
});
