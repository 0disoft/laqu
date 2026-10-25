import { deepStrictEqual, strictEqual } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

test("bundled CLI runs without laqu package files or node_modules", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "laqu-bundle-"));
  const bundle = join(temporaryRoot, "cli.mjs");
  const metadata = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  try {
    execFileSync(
      "bun",
      [
        "build",
        resolve("test/fixtures/bundled-consumer.mjs"),
        "--target=node",
        "--format=esm",
        "--outfile",
        bundle,
      ],
      { stdio: "pipe" },
    );
    const result = spawnSync(process.execPath, [bundle], {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: { ...process.env, LAQU_EXPECTED_VERSION: metadata.version },
    });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(result.stderr, "");
    deepStrictEqual(JSON.parse(result.stdout), { status: "ready" });
  } finally {
    // Only remove the uniquely created child of the OS temporary directory.
    strictEqual(dirname(resolve(temporaryRoot)), resolve(tmpdir()));
    strictEqual(basename(temporaryRoot).startsWith("laqu-bundle-"), true);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
