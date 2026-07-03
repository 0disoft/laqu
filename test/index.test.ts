import { strictEqual } from "node:assert";
import test from "node:test";

import { createLaqu } from "../src/index.js";

test("exports runtime factory", () => {
  strictEqual(typeof createLaqu, "function");
});
