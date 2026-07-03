# laqu

`laqu` is a strict TypeScript runtime for reliable terminal progress and live CLI rendering on Node.js 24+.

It treats stdout as the data channel and sends progress, status, logs, human rendering, and JSON/NDJSON progress events to stderr by default. The runtime keeps output format, stream capability, channel role, and progress policy as separate decisions instead of hiding them behind one mode enum.

## Install

```sh
bun add laqu
```

The published package targets Node.js 24+ and does not require Bun, Deno, Rust, native addons, WASM, or C++ bindings at runtime.

## Scoped Tasks

```ts
import { createLaqu } from "laqu";

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
import { createProgressRuntime } from "laqu";

const progress = createProgressRuntime();
const build = progress.createTask("build", { total: 3 });

build.advance(1);
build.setMessage("typecheck");
build.advance(1);
build.setMessage("bundle");
build.advance(1);
build.succeed("done");

await progress.close();
```

The API avoids ambiguous calls such as `update(42)`. Use `setCompleted(42)` for absolute progress and `advance(42)` for a delta.

## Logs

```ts
const progress = createLaqu();

progress.log("cache hit");
await progress.close();
```

Logs are separate scrollback records. They are not rendered as task rows and they pass through the same output coordinator as progress frames so live regions and log lines do not corrupt each other.

## Output Contract

By default:

- stdout is reserved for user data such as JSON, NDJSON, CSV, file lists, or binary output.
- stderr is used for progress, status, logs, and machine-readable progress events.
- human live rendering is enabled only when the status stream is a TTY and the environment is not CI.
- CI, pipe, dumb terminal, and non-TTY output fall back to plain append rendering unless a different policy is requested.
- JSON/NDJSON progress events do not go to stdout unless the caller explicitly passes a separate status stream that points there.

```ts
const progress = createLaqu({
  format: "json",
  progressPolicy: "jsonl",
  stderr: process.stderr,
});
```

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
import { displayWidth, truncateToColumns, wrapToColumns } from "laqu";

displayWidth("\u001b[31m한글\u001b[0m"); // 4
truncateToColumns("👩‍💻 building", 8, { overflowMarker: "..." });
wrapToColumns("abcd한글", 4);
```

ANSI/control sequences are tokenized as zero-width. Text is segmented by grapheme, CJK/fullwidth characters are treated as two columns, combining marks as zero columns, emoji/ZWJ clusters as two columns, and ambiguous width defaults to one column unless overridden.

## Child Process Output

Do not mix child process output with live rendering through `stdio: "inherit"`. Pipe child output through the parent process and write it with `runtime.log()`, or close/pause the live renderer and run the child command in plain/log mode.

## Development

```sh
bun install
bun run check
```

`bun run check` runs strict typecheck, OXC lint, OXC format check, Node.js built-in tests, and build output generation.
