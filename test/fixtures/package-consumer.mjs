import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), "laqu-package-consumer-"));
const packDirectory = join(temporaryRoot, "pack");
const consumerDirectory = join(temporaryRoot, "consumer");
const commandEnvironment = { ...process.env, npm_config_update_notifier: "false" };
const npm = resolveNpmCommand();

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });
  const packed = JSON.parse(
    runNpm(["pack", "--json", "--pack-destination", packDirectory], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: commandEnvironment,
    }),
  );
  const packageRecord = packed?.[0];
  if (
    !Array.isArray(packed) ||
    packed.length !== 1 ||
    typeof packageRecord?.filename !== "string"
  ) {
    throw new Error("npm pack must return exactly one package tarball");
  }
  const tarball = join(packDirectory, packageRecord.filename);

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "laqu-empty-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  runNpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: consumerDirectory, stdio: "pipe", env: commandEnvironment },
  );

  const installedPackage = join(consumerDirectory, "node_modules", "@0disoft", "laqu");
  if (!existsSync(join(installedPackage, "media", "terminal-preview.svg"))) {
    throw new Error("packed package must include the README terminal preview");
  }
  if (!existsSync(join(installedPackage, "CHANGELOG.md"))) {
    throw new Error("packed package must include the changelog");
  }

  writeFixture("consumer.mjs", "test/fixtures/consumer-esm.mjs");
  writeFixture("consumer.ts", "test/fixtures/consumer-ts/consumer.ts");
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          lib: ["ES2024"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2024",
          typeRoots: [resolve("node_modules/@types")],
          types: ["node"],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );

  execFileSync(process.execPath, [join(consumerDirectory, "consumer.mjs")], {
    cwd: consumerDirectory,
    stdio: "pipe",
  });
  execFileSync(
    process.execPath,
    [resolve("node_modules/typescript/bin/tsc"), "-p", join(consumerDirectory, "tsconfig.json")],
    { cwd: repositoryRoot, stdio: "pipe" },
  );

  const cleanStdout = runExample("clean-stdout.mjs");
  const artifact = JSON.parse(cleanStdout.stdout);
  if (artifact.artifact !== "dist/laqu.js" || artifact.status !== "ready") {
    throw new Error("clean stdout example must emit the documented JSON result");
  }
  if (cleanStdout.stderr.length === 0) {
    throw new Error("clean stdout example must keep progress on stderr");
  }

  runExample("nested-tasks.mjs");
  const ndjson = runExample("ndjson-events.mjs");
  const events = ndjson.stderr
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  if (events.length === 0 || events.some((event) => event.schema !== "laqu.event")) {
    throw new Error("NDJSON example must emit versioned laqu events");
  }

  process.stdout.write(
    `${JSON.stringify({
      id: packageRecord.id,
      filename: packageRecord.filename,
      entryCount: packageRecord.entryCount,
      installedConsumer: true,
      strictTypes: true,
      examplesExecuted: 3,
    })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function writeFixture(targetName, sourcePath) {
  const target = join(consumerDirectory, targetName);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(resolve(sourcePath)));
}

function runExample(name) {
  const result = spawnSync(process.execPath, [join(installedPackage, "examples", name)], {
    cwd: consumerDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${name} failed with exit code ${result.status}: ${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function runNpm(arguments_, options) {
  return execFileSync(npm.command, [...npm.prefixArguments, ...arguments_], options);
}

function resolveNpmCommand() {
  if (process.platform !== "win32") {
    return { command: "npm", prefixArguments: [] };
  }
  const shim = execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .find((candidate) => candidate.length > 0);
  if (shim === undefined) {
    throw new Error("npm.cmd is not available on PATH");
  }
  const cli = join(dirname(shim), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(cli)) {
    throw new Error(`npm CLI was not found beside its Windows shim: ${cli}`);
  }
  return { command: process.execPath, prefixArguments: [cli] };
}
