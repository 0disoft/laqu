import { readFileSync, writeFileSync } from "node:fs";

const [tag, outputPath] = process.argv.slice(2);

if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? "")) {
  throw new Error("release tag must use the vMAJOR.MINOR.PATCH form");
}
if (outputPath === undefined || outputPath.length === 0) {
  throw new Error("release notes output path is required");
}

const version = tag.slice(1);
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const heading = `## [${version}]`;
const sectionStart = changelog.indexOf(heading);

if (sectionStart === -1) {
  throw new Error(`CHANGELOG.md has no section for ${version}`);
}

const bodyStart = changelog.indexOf("\n", sectionStart);
const nextSection = changelog.indexOf("\n## [", bodyStart + 1);
const body = changelog.slice(bodyStart + 1, nextSection === -1 ? undefined : nextSection).trim();

if (body.length === 0) {
  throw new Error(`CHANGELOG.md section for ${version} is empty`);
}

writeFileSync(outputPath, `${body}\n`);
