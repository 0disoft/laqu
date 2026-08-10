import { deepStrictEqual, strictEqual, throws } from "node:assert";
import test from "node:test";

import {
  displayWidth,
  graphemes,
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

test("width corpus covers East Asian text and Unicode emoji presentation", () => {
  strictEqual(displayWidth("한글"), 4);
  strictEqual(displayWidth("表"), 2);
  strictEqual(displayWidth("𠀀"), 2);
  strictEqual(displayWidth("👩‍💻"), 2);
  strictEqual(displayWidth("👍🏽"), 2);
  strictEqual(displayWidth("🇰🇷"), 2);
  strictEqual(displayWidth("1️⃣"), 2);
  strictEqual(displayWidth("©"), 1);
  strictEqual(displayWidth("©︎"), 1);
  strictEqual(displayWidth("©️"), 2);
  strictEqual(displayWidth("e\u0301"), 1);
  strictEqual(displayWidth("שְ"), 1);
  strictEqual(displayWidth("\u05B0"), 0);
  strictEqual(displayWidth("a\uFE0F"), 1);
  strictEqual(displayWidth("a\tb", { tabSize: 2 }), 3);
  strictEqual(displayWidth("abc\tz", { tabSize: 8 }), 9);
});

test("width-sensitive helpers preserve grapheme and column invariants across the corpus", () => {
  const corpus = ["©", "©️", "1️⃣", "שְ", "👩‍💻", "👍🏽", "🇰🇷", "한글", "e\u0301"];

  for (const value of corpus) {
    for (let columns = 1; columns <= 4; columns += 1) {
      const truncated = truncateToColumns(value, columns, { overflowMarker: "…" });
      strictEqual(
        displayWidth(truncated) <= columns,
        true,
        `${JSON.stringify(value)} @ ${columns}`,
      );
      strictEqual(
        wrapToColumns(value, columns).every((line) => {
          const width = displayWidth(line);
          return width <= columns || (graphemes(line).length === 1 && width > columns);
        }),
        true,
        `${JSON.stringify(value)} wrap @ ${columns}`,
      );
    }
  }
});

test("width helpers reject invalid tab sizes consistently", () => {
  for (const tabSize of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    throws(() => displayWidth("a\tb", { tabSize }), {
      name: "TypeError",
      message: "tabSize must be a safe positive integer",
    });
    throws(() => truncateToColumns("a\tb", 10, { tabSize }), {
      name: "TypeError",
      message: "tabSize must be a safe positive integer",
    });
    throws(() => wrapToColumns("a\tb", 10, { tabSize }), {
      name: "TypeError",
      message: "tabSize must be a safe positive integer",
    });
  }
});

test("ambiguous width can be overridden", () => {
  strictEqual(displayWidth("¡", { ambiguousWidth: 1 }), 1);
  strictEqual(displayWidth("¡", { ambiguousWidth: 2 }), 2);
  strictEqual(displayWidth("©", { ambiguousWidth: 2 }), 1);
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

test("truncate resets extended SGR color sequences", () => {
  const trueColor = truncateToColumns("\u001b[38;2;255;128;0mabcdef", 4, {
    overflowMarker: "…",
  });
  const indexedColor = truncateToColumns("\u001b[48;5;196mabcdef", 4, {
    overflowMarker: "…",
  });

  strictEqual(trueColor, "\u001b[38;2;255;128;0mabc…\u001b[0m");
  strictEqual(indexedColor, "\u001b[48;5;196mabc…\u001b[0m");
  strictEqual(displayWidth(trueColor), 4);
  strictEqual(displayWidth(indexedColor), 4);
});

test("truncate never lets overflow marker exceed target columns", () => {
  const truncated = truncateToColumns("abcdef", 1, { overflowMarker: "..." });

  strictEqual(truncated, ".");
  strictEqual(displayWidth(truncated), 1);
});

test("truncate does not reserve an overflow marker for exact-width text", () => {
  strictEqual(truncateToColumns("abcd", 4, { overflowMarker: "…" }), "abcd");
});

test("truncate expands tabs from the current column", () => {
  const truncated = truncateToColumns("abc\tz", 9, { tabSize: 8 });

  strictEqual(truncated, "abc     z");
  strictEqual(displayWidth(truncated), 9);
});

test("wrap respects column width without relying on terminal autowrap", () => {
  deepStrictEqual(wrapToColumns("abcd한글", 4), ["abcd", "한글"]);
  deepStrictEqual(wrapToColumns("abc\tz", 8, { tabSize: 8 }), ["abc     ", "z"]);
});
