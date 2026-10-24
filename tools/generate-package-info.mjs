import { existsSync, readFileSync, writeFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new TypeError("package.json must contain a version string");
}

const output = new URL("../src/package-info.ts", import.meta.url);
const source = `// Generated from package.json by tools/generate-package-info.mjs. Do not edit.\nexport const packageVersion: string = ${JSON.stringify(metadata.version)};\n`;
if (!existsSync(output) || readFileSync(output, "utf8") !== source) {
  writeFileSync(output, source);
}
