import { strictEqual } from "node:assert";
import test from "node:test";

import { packageName } from "../src/index.js";

test("exports package name", () => {
  strictEqual(packageName, "laqu");
});
