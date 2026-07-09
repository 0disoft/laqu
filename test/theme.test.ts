import { ok, strictEqual } from "node:assert";
import test from "node:test";

import { compileTheme, dangerouslyRawAnsi, renderSegments, text } from "../src/theme.js";

test("theme compiles preset tokens with semantic overrides", () => {
  const theme = compileTheme({ successSymbol: "ok", useColor: false });

  strictEqual(theme.tokens.successSymbol, "ok");
  strictEqual(renderSegments(theme, [text("done", "success")]), "done");
});

test("raw ANSI is isolated behind explicit dangerous API", () => {
  const theme = compileTheme({ useColor: false });

  const rendered = renderSegments(theme, [dangerouslyRawAnsi("\u001b[31mraw")]);
  ok(rendered.includes("\u001b[31m"));
});

test("ordinary themed text strips terminal control sequences", () => {
  const theme = compileTheme({ useColor: false });

  const rendered = renderSegments(theme, [text("\u001b[31mred\u001b[0m\rspoof")]);
  strictEqual(rendered, "red spoof");
});

test("semantic theme tokens strip terminal control sequences", () => {
  const theme = compileTheme({
    overflowMarker: "\u001b]52;c;SGVsbG8=\u0007!",
    runningSymbol: "\u001b[31mrun\u001b[0m",
    useColor: false,
  });

  strictEqual(theme.tokens.overflowMarker, "!");
  strictEqual(theme.tokens.runningSymbol, "run");
});
