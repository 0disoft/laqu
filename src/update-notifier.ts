import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { packageVersion } from "./package-info.js";

const cacheLifetimeMs = 24 * 60 * 60 * 1000;
const responseLimit = 8192;

interface UpdateDependencies {
  readonly currentVersion: string;
  now(): number;
  readCache(): Promise<string | undefined>;
  writeCache(value: string): Promise<void>;
  fetchVersion(signal: AbortSignal): Promise<string | undefined>;
}

export function createUpdateNotifier(dependencies: UpdateDependencies) {
  const listeners = new Set<(version: string) => void>();
  const controller = new AbortController();
  let started = false;
  let announced = false;
  let available: string | undefined;

  function deliver(): void {
    if (announced || available === undefined || controller.signal.aborted) return;
    for (const listener of listeners) {
      // At most one notice per process, even with concurrent runtimes.
      announced = true;
      listener(available);
      break;
    }
  }

  async function check(): Promise<void> {
    const now = dependencies.now();
    const cached = await dependencies.readCache().catch(() => undefined);
    if (controller.signal.aborted) return;
    let latest: string | undefined;
    if (cached !== undefined && cached.length <= responseLimit) {
      try {
        const record = JSON.parse(cached) as { checkedAt?: unknown; latest?: unknown };
        if (
          typeof record.checkedAt === "number" &&
          Number.isFinite(record.checkedAt) &&
          record.checkedAt <= now &&
          now - record.checkedAt < cacheLifetimeMs &&
          typeof record.latest === "string" &&
          parseVersion(record.latest) !== undefined
        ) {
          latest = record.latest;
        }
      } catch {
        // Corrupt or partial cache entries are safe to refresh.
      }
    }
    if (latest === undefined) {
      latest = await dependencies.fetchVersion(controller.signal);
      if (controller.signal.aborted || latest === undefined || parseVersion(latest) === undefined)
        return;
      // Cache storage must not delay the notice or make an update check fail.
      void dependencies.writeCache(JSON.stringify({ checkedAt: now, latest })).catch(() => {});
    }
    if (isNewerStableVersion(latest, dependencies.currentVersion)) {
      available = latest;
      deliver();
    }
  }

  return {
    subscribe(listener: (version: string) => void): () => void {
      if (announced || controller.signal.aborted) return () => {};
      listeners.add(listener);
      if (!started) {
        started = true;
        void check().catch(() => {});
      } else {
        queueMicrotask(() => deliver());
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) controller.abort();
      };
    },
  };
}

function parseVersion(value: string): { core: readonly bigint[]; prerelease: boolean } | undefined {
  if (value.length > 128) return undefined;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/u.exec(
      value,
    );
  if (match === null) return undefined;
  if (match[4]?.split(".").some((part) => /^0\d+$/u.test(part))) return undefined;
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4] !== undefined,
  };
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const latest = parseVersion(candidate);
  const installed = parseVersion(current);
  if (latest === undefined || installed === undefined || latest.prerelease) return false;
  for (let index = 0; index < 3; index += 1) {
    const next = latest.core[index]!;
    const previous = installed.core[index]!;
    if (next !== previous) return next > previous;
  }
  return installed.prerelease;
}

export function fetchLatestVersion(signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = get("https://registry.npmjs.org/@0disoft%2Flaqu/latest", {
      signal,
      headers: { accept: "application/json", "user-agent": `laqu/${packageVersion}` },
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish();
    }, 1500);
    timer.unref();
    const finish = (version?: string) => {
      clearTimeout(timer);
      resolve(version);
    };
    request.on("socket", (socket) => socket.unref());
    request.on("error", () => finish());
    request.on("close", () => finish());
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        finish();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > responseLimit) {
          response.destroy();
          finish();
        } else {
          chunks.push(chunk);
        }
      });
      response.on("error", () => finish());
      response.on("close", () => finish());
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { version?: unknown };
          finish(
            typeof body.version === "string" && parseVersion(body.version) !== undefined
              ? body.version
              : undefined,
          );
        } catch {
          finish();
        }
      });
    });
  });
}

function cachePath(): string {
  const root =
    process.platform === "win32"
      ? (process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"))
      : (process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"));
  return join(root, "laqu", "update-check.json");
}

async function readCache(): Promise<string | undefined> {
  const file = await open(cachePath(), "r");
  try {
    const buffer = Buffer.alloc(responseLimit + 1);
    const { bytesRead } = await file.read(buffer);
    return bytesRead > responseLimit ? undefined : buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

async function writeCache(value: string): Promise<void> {
  const path = cachePath();
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export const updateNotifier = createUpdateNotifier({
  currentVersion: packageVersion,
  now: Date.now,
  readCache,
  writeCache,
  fetchVersion: fetchLatestVersion,
});
