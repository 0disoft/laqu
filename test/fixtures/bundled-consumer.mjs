import assert from "node:assert/strict";

import { createLaqu } from "../../src/index.ts";

const chunks = [];
const runtime = createLaqu({
  stderr: {
    isTTY: true,
    columns: 80,
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
  },
  env: {},
  checkForUpdates: false,
  theme: { useColor: false },
});
runtime.createTask("bundled CLI", { total: 1, completed: 1 }).succeed();
await runtime.close();
assert.ok(chunks.join("").includes(`laqu ${process.env["LAQU_EXPECTED_VERSION"]}`));
process.stdout.write(`${JSON.stringify({ status: "ready" })}\n`);
