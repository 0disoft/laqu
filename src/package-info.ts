import { readFileSync } from "node:fs";

// Self-resolution also locates the package when tests run from dist-test/src.
const metadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.resolve("@0disoft/laqu")), "utf8"),
) as { version: string };

export const packageVersion = metadata.version;
