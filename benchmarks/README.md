# Local performance baseline

Run `bun run bench:quick` after installing the project's development dependencies. In the shared
workspace, use the configured `laqu_bench_quick` mustflow intent. The command builds the current
source and prints one JSON report; it is not part of CI or a release gate.

The report records three raw samples for 10, 1,000, and 10,000 running tasks, with an 80-column,
10-row live renderer after one small warmup. It also measures a 1,000-level tree and 50 short tasks
on a status stream whose write callbacks are delayed by 2 ms. Timings use a monotonic clock in
milliseconds. Heap numbers are raw `heapUsed` readings after forced garbage collection; they vary
between samples and must not be treated as exact bytes retained by tasks. `frameBytes` counts
only rendered live lines; `peakWritableBytes` is Node's stream buffer, not laqu's internal queue.

Compare runs only on the same Node version, machine, and workload. Keep the raw samples: a single
local run cannot establish a regression or a release budget. The script emits no environment values,
repository paths, or task source text.

## Long diagnostic wrapping

Run `bun run build` followed by `node benchmarks/wrap-width.mjs`. Each of three fresh Node
processes warms up, creates 150,000 repetitions of `👩‍💻e\u0301` (300,000 graphemes), forces GC,
and wraps the text to 80 columns. The script records elapsed time and process peak RSS before
validating every line's width, complete text preservation, and the SHA-256 of the wrapped output.
Peak RSS includes the runtime, input, output, and temporary allocations; it is not the size of
the grapheme array alone. The benchmark is local and is not a CI timing gate.

On Windows / Node.js 24.18.0, measured on 2026-10-25:

| Implementation                   | Median time (ms) | Median process peak RSS (bytes) |
| -------------------------------- | ---------------: | ------------------------------: |
| Eager grapheme array (`f9725b5`) |         651.8792 |                       131444736 |
| Incremental grapheme iterator    |         478.5590 |                       113463296 |

Raw eager samples: time `[754.6397, 651.8792, 580.6122]` ms; peak RSS
`[133369856, 119824384, 131444736]` bytes. Raw incremental samples: time
`[478.5590, 574.1463, 376.1135]` ms; peak RSS `[113364992, 114642944, 113463296]` bytes.
All six outputs contained 5,661 lines with SHA-256
`ca2fc41ac0db6ae69cc996f03901c42a1c2078d398c5005037cdfd7c50e731d5`.

The removed intermediate array stored one entry for every grapheme: O(G) temporary entries
become zero. Input and returned lines still require O(N) space, and wrapping still takes O(N)
time for this corpus. Local medians are workload evidence rather than cross-platform guarantees.

## Silent scoped tasks

Run `bun run build` followed by `node benchmarks/silent-tasks.mjs`. Each policy gets three fresh
processes, a 20-task warmup, and 3,000 sequential scoped callbacks with the default 1,000-terminal-task
retention limit. The script verifies return-value sum `4498500` and zero writes. Its constant-time
snapshot instrumentation counts snapshot calls and returned root task objects in this flat workload;
it does not traverse the task tree or change retention.

On Windows / Node.js 24.18.0, measured on 2026-10-25:

| Policy   | Baseline median (ms) | Optimized median (ms) | Snapshot calls before → after | Task snapshot objects before → after |
| -------- | -------------------: | --------------------: | ----------------------------: | -----------------------------------: |
| `silent` |             794.0011 |               34.7989 |                      3002 → 1 |                       2502500 → 1000 |
| `never`  |            1275.7118 |               33.8337 |                      3002 → 1 |                       2502500 → 1000 |

Baseline commit: `39514df`. Raw times for `silent`: baseline `[794.0011, 792.4640, 879.4341]`,
optimized `[38.4925, 34.7989, 30.8823]` ms. Raw times for `never`: baseline
`[1159.1764, 1275.7118, 1321.7527]`, optimized `[33.8337, 43.7033, 33.1653]` ms.
Every sample had the same counts and return-value sum. The remaining snapshot is taken once at
finalization. Routine quiet flushes perform retention work and propagate sticky stream errors.
For N sequential tasks and retention limit R, removed snapshot work was O(N × min(N, R));
only O(min(N, R)) final snapshot work remains. Timings are local observations, not CI budgets.
