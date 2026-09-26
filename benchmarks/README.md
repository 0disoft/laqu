# Local performance baseline

Run `bun run bench:quick` after installing the project's development dependencies. In the shared
workspace, use the configured `laqu_bench_quick` mustflow intent. The command builds the current
source and prints one JSON report; it is not part of CI or a release gate.

The report records three raw samples for 10, 1,000, and 10,000 running tasks, with an 80-column,
10-row live renderer. It also measures a 1,000-level tree and 50 short tasks on a status stream
whose write callbacks are delayed by 2 ms. Timings use a monotonic clock in milliseconds. Heap
numbers are approximate retained-byte deltas after forced garbage collection. `frameBytes` counts
only rendered live lines; `peakWritableBytes` is Node's stream buffer, not laqu's internal queue.

Compare runs only on the same Node version, machine, and workload. Keep the raw samples: a single
local run cannot establish a regression or a release budget. The script emits no environment values,
repository paths, or task source text.
