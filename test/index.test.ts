import { strictEqual } from "node:assert";
import test from "node:test";

import { createLaqu, LaquOutputError } from "../src/index.js";

test("exports runtime factory", () => {
  strictEqual(typeof createLaqu, "function");
  strictEqual(typeof LaquOutputError, "function");
});
