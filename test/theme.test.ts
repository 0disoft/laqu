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
