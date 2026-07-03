import { strictEqual } from "node:assert";
import test from "node:test";

import { chooseRenderer } from "../src/renderer.js";
import { compileTheme } from "../src/theme.js";

const theme = compileTheme({ useColor: false });

test("auto uses live renderer only for human tty", () => {
  const decision = chooseRenderer({
    format: "human",
    policy: "auto",
    capability: "tty",
    theme,
    columns: 80,
    maxRows: 10,
  });

  strictEqual(decision.live, true);
});

test("auto falls back to plain renderer in CI pipe and dumb terminals", () => {
  for (const capability of ["ci", "pipe", "dumb"] as const) {
    const decision = chooseRenderer({
      format: "human",
      policy: "auto",
      capability,
      theme,
      columns: 80,
      maxRows: 10,
    });
    strictEqual(decision.live, false);
  }
});

test("JSON formats select event renderer instead of live cursor control", () => {
  const decision = chooseRenderer({
    format: "json",
    policy: "auto",
    capability: "tty",
    theme,
    columns: 80,
    maxRows: 10,
  });

  strictEqual(decision.live, false);
});
