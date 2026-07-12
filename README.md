# laqu

`laqu` is a strict TypeScript runtime for reliable terminal progress and live CLI rendering on Node.js 24+.

It treats stdout as the data channel and sends progress, status, logs, human rendering, and JSON/NDJSON progress events to stderr by default. The runtime keeps output format, stream capability, channel role, and progress policy as separate decisions instead of hiding them behind one mode enum.

## Install

```sh
bun add @0disoft/laqu
```

The published package targets Node.js 24+ and does not require Bun, Deno, Rust, native addons, WASM, or C++ bindings at runtime.

## Scoped Tasks

```ts
import { createLaqu } from "@0disoft/laqu";

const progress = createLaqu();

await progress.task("download", { total: 100 }, async (task) => {
  task.setMessage("starting");
  task.advance(25);
  task.setDetail("chunk 1/4");
  task.advance(75);
});

await progress.close();
```

Scoped tasks mark themselves as succeeded when the callback resolves. If the callback throws, the task is marked failed and the original error is rethrown. If the task receives an aborted `AbortSignal`, it is marked cancelled and cleanup still runs.

## Manual Tasks

```ts
import { createProgressRuntime } from "@0disoft/laqu";

const progress = createProgressRuntime();
const build = progress.createTask("build", { total: 3 });

build.advance(1);
build.setMessage("typecheck");
build.advance(1);
build.setMessage("bundle");
build.advance(1);
build.succeed("done");

const optional = progress.createTask("optional cache warmup");
optional.skip("already warm");

await progress.close();
```

The API avoids ambiguous calls such as `update(42)`. Use `setCompleted(42)` for absolute progress and `advance(42)` for a delta.
Manual tasks also honor `TaskOptions.signal`; aborting the signal marks the task cancelled with the message `aborted`. Use `task.skip(message)` for intentionally skipped work such as cache hits, disabled feature branches, or already up-to-date steps.

After `progress.close()` starts, the runtime stops accepting new tasks, logs, and task handle updates. Create a new runtime for later progress output.

## Logs

```ts
const progress = createLaqu();

progress.log("cache hit");
await progress.close();
```

Logs are separate scrollback records. They are not rendered as task rows and they pass through the same output coordinator as progress frames so live regions and log lines do not corrupt each other.

## Process Lifecycle

`laqu` does not install process-level signal or exception handlers by default. Applications that
already own shutdown should keep the default and call `progress.close()` from their own cleanup
path.

Short-lived CLI commands that want `laqu` to flush progress output during `SIGINT`, `SIGTERM`,
`uncaughtException`, or `unhandledRejection` can opt in:

```ts
const progress = createLaqu({
  manageProcessLifecycle: true,
});
```

## Public Imports

The root import exposes the stable runtime API and common helpers:

```ts
import { createLaqu, displayWidth } from "@0disoft/laqu";
```

Focused subpath exports are available for narrower consumers:

```ts
import { LAQU_EVENT_SCHEMA_VERSION } from "@0disoft/laqu/events";
import { compileTheme } from "@0disoft/laqu/theme";
import { displayWidth } from "@0disoft/laqu/width";
```

## Output Contract

By default:

- stdout is reserved for user data such as JSON, NDJSON, CSV, file lists, or binary output.
- stderr is used for progress, status, logs, and machine-readable progress events.
- human live rendering is enabled only when the status stream is a TTY and the environment is not CI.
- only one runtime owns live rendering for a stream at a time; concurrent runtimes on that same stream fall back to plain append rendering until the live owner closes.
- CI, pipe, dumb terminal, and non-TTY output fall back to plain append rendering unless a different policy is requested.
- plain append rendering preserves every task state transition and full sanitized log text; `maxRows` and terminal-width truncation apply only to live rendering.
- JSON/NDJSON progress events do not go to stdout unless the caller explicitly passes a separate status stream that points there.

```ts
const progress = createLaqu({
  format: "ndjson",
  progressPolicy: "jsonl",
  retention: { maxLogs: 1000, maxTerminalTasks: 1000 },
  stderr: process.stderr,
});
```

Machine-readable progress events use a versioned schema. `format: "json"` writes one parseable JSON array when the runtime closes; `format: "ndjson"` and `progressPolicy: "jsonl"` write newline-delimited event objects as work progresses.

The runtime retains the newest 1000 log records and 1000 terminal task records by default so long-running commands do not keep unbounded output buffers. Set `retention.maxLogs` or `retention.maxTerminalTasks` to smaller non-negative integers when only the latest output window should be rendered or emitted. Terminal task pruning affects retained task rows and task events only after the terminal task has been snapshotted for rendering; summary events keep lifecycle counts for all tasks created by the runtime.
Task event fields such as `parentId`, `message`, and `detail` are omitted when they are absent.

```json
{
  "schema": "laqu.event",
  "version": 1,
  "type": "task",
  "task": {
    "id": "task-1",
    "title": "download",
    "status": "running",
    "depth": 0,
    "progress": {
      "kind": "ratio",
      "ratio": 0.5,
      "overrun": false
    }
  }
}
```

Event schema version `1` is exported as `LAQU_EVENT_SCHEMA_VERSION`.

The selection axes are independent:

- `format`: `human`, `json`, or `ndjson`
- `streamCapability`: `tty`, `ci`, `pipe`, or `dumb`
- channel role: stdout as data, stderr/status stream as progress
- `progressPolicy`: `auto`, `always`, `never`, `plain`, `jsonl`, or `silent`

## Themes

Themes are token-first:

```ts
const progress = createLaqu({
  theme: {
    successSymbol: "ok",
    runningSymbol: ">",
    progressComplete: "=",
    overflowMarker: "...",
  },
});
```

Theme tokens are semantic: success symbols, running symbols, progress glyphs, indentation, gaps, and overflow markers. Slot-level formatting should return safe renderable segments rather than raw strings with cursor movement.

`dangerouslyRawAnsi()` exists as an escape hatch for callers that need raw ANSI. It can break width measurement, fallback rendering, and reset guarantees if used incorrectly, so keep it isolated.

## Width And ANSI

`laqu` includes a pure TypeScript width engine:

```ts
import { displayWidth, truncateToColumns, wrapToColumns } from "@0disoft/laqu";

displayWidth("\u001b[31m한글\u001b[0m"); // 4
truncateToColumns("👩‍💻 building", 8, { overflowMarker: "..." });
wrapToColumns("abcd한글", 4);
```

ANSI/control sequences are tokenized as zero-width. Text is segmented by grapheme, CJK/fullwidth characters are treated as two columns, combining marks as zero columns, emoji/ZWJ clusters as two columns, and ambiguous width defaults to one column unless overridden.

## Child Process Output

Do not mix child process output with live rendering through `stdio: "inherit"`. Pipe child output through the parent process and write it with `runtime.log()`, close the runtime before handing the terminal directly to the child process, or run progress output in plain/log mode.

## Development

```sh
bun install
bun run check
bun run pack:check
bun run example:basic
```

`bun run check` runs strict typecheck, OXC lint, OXC format check, Node.js built-in tests, and build output generation.
`bun run pack:check` builds the package, runs an ESM consumer fixture through package self-reference imports, and verifies the package contents with `npm pack --dry-run --json`.
`bun run example:basic` builds the package and runs a small live progress demo. Terminal scrollback keeps the final frame; watch the command while it runs to see the bar animate in place.

## Release

GitHub Actions publishes npm releases from maintainer-created version tags. The tag must match `package.json` exactly, for example `v1.0.8` for version `1.0.8`.

```sh
git tag -a v1.0.8 -m "v1.0.8"
git push origin main v1.0.8
```

The npm package must define a Trusted Publisher connection for GitHub Actions with organization/user `0disoft`, repository `laqu`, workflow filename `release.yml`, environment name `npm`, and `npm publish` allowed. The GitHub repository must also define an `npm` environment with required reviewers and a deployment tag rule that allows only `v*.*.*` tags.

On a matching tag push, the workflow first verifies the tag, package metadata, tests, build, and dry pack output with read-only repository permissions. The publish job then waits on the `npm` environment gate, repeats package verification on the tagged commit, packs the release tarball, uploads that exact tarball as a retained workflow artifact, publishes the same tarball to npm with provenance through OIDC, and creates a GitHub Release with generated notes.
