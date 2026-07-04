import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import {
  displayWidth,
  stripAnsi,
  tokenizeAnsi,
  truncateToColumns,
  wrapToColumns,
} from "../src/width.js";

test("ANSI tokens are zero width", () => {
  const input = "\u001b[31mred\u001b[0m";

  strictEqual(stripAnsi(input), "red");
  strictEqual(displayWidth(input), 3);
  deepStrictEqual(
    tokenizeAnsi(input).map((token) => token.kind),
    ["ansi", "text", "ansi"],
  );
});

test("OSC hyperlink sequence is zero width", () => {
  const link = "\u001b]8;;https://example.com\u0007docs\u001b]8;;\u0007";

  strictEqual(displayWidth(link), 4);
  strictEqual(stripAnsi(link), "docs");
});

test("width corpus covers Korean CJK emoji combining marks and tabs", () => {
  strictEqual(displayWidth("한글"), 4);
  strictEqual(displayWidth("表"), 2);
  strictEqual(displayWidth("𠀀"), 2);
  strictEqual(displayWidth("👩‍💻"), 2);
  strictEqual(displayWidth("e\u0301"), 1);
  strictEqual(displayWidth("a\uFE0F"), 1);
  strictEqual(displayWidth("a\tb", { tabSize: 2 }), 4);
});

test("ambiguous width can be overridden", () => {
  strictEqual(displayWidth("¡", { ambiguousWidth: 1 }), 1);
  strictEqual(displayWidth("¡", { ambiguousWidth: 2 }), 2);
});

test("truncate never cuts through ANSI sequence or grapheme", () => {
  const red = "\u001b[31m한글\u001b[0m";

  strictEqual(truncateToColumns(red, 3, { overflowMarker: "…" }), "\u001b[31m한…\u001b[0m");
  strictEqual(displayWidth(truncateToColumns("👩‍💻abc", 3, { overflowMarker: "…" })), 3);
});

test("truncate preserves reset sequences that were already opened before visible text", () => {
  const truncated = truncateToColumns("\u001b[32mabcdef\u001b[0m", 4, { overflowMarker: "…" });

  strictEqual(truncated, "\u001b[32mabc…\u001b[0m");
  strictEqual(displayWidth(truncated), 4);
});

test("truncate resets SGR sequences that reset and then reopen style", () => {
  const truncated = truncateToColumns("\u001b[0;31mabcdef\u001b[0m", 4, {
    overflowMarker: "…",
  });

  strictEqual(truncated, "\u001b[0;31mabc…\u001b[0m");
  strictEqual(displayWidth(truncated), 4);
});

test("truncate never lets overflow marker exceed target columns", () => {
  const truncated = truncateToColumns("abcdef", 1, { overflowMarker: "..." });

  strictEqual(truncated, ".");
  strictEqual(displayWidth(truncated), 1);
});

test("wrap respects column width without relying on terminal autowrap", () => {
  deepStrictEqual(wrapToColumns("abcd한글", 4), ["abcd", "한글"]);
});
