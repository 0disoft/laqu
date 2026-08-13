import { match, ok } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("extracts curated notes for the release tag", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "laqu-release-notes-"));
  const output = join(temporaryRoot, "notes.md");

  try {
    execFileSync(process.execPath, [resolve("tools/extract-release-notes.mjs"), "v1.1.9", output]);
    const notes = readFileSync(output, "utf8");

    match(notes, /### Added/u);
    match(notes, /### Compatibility/u);
    ok(!notes.includes("## [1.1.8]"));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a tag that has no changelog section", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("tools/extract-release-notes.mjs"), "v9.9.9", "missing-release-notes.md"],
    { encoding: "utf8" },
  );

  ok(result.status !== 0);
  match(result.stderr, /CHANGELOG\.md has no section for 9\.9\.9/u);
});

test("rejects an invalid release tag", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("tools/extract-release-notes.mjs"), "latest", "invalid-release-notes.md"],
    { encoding: "utf8" },
  );

  ok(result.status !== 0);
  match(result.stderr, /release tag must use the vMAJOR\.MINOR\.PATCH form/u);
});
