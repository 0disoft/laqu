# System Boundary

- Status: Active

## Boundary

The repository owns the `@0disoft/laqu` library, its public declarations and package exports,
in-memory task state, renderer selection, terminal output coordination, event serialization,
display-width logic, tests, examples, and release workflow.

The caller owns stdout data, business operations, process shutdown policy, child-process execution,
and any status stream supplied to the runtime. The package consumes Node.js process and stream
primitives but does not own a service, database, network protocol, or durable state.

## Runtime Flow

1. `createLaqu()` validates options, detects the status-stream capability, compiles the theme, and
   chooses a renderer.
2. The runtime acquires a live-stream lease when possible and otherwise selects a safe fallback.
3. Task handles mutate `TaskStore`; snapshots derive hierarchy, aggregate progress, logs, and
   summary counts.
4. A throttled flush sends a snapshot to the renderer and then to `OutputCoordinator`.
5. The coordinator serializes writes, coalesces pending frames under backpressure, and maintains the
   live terminal lease.
6. `close()` moves through `open → draining → finalizing → closed`. Draining rejects new caller
   work while existing scoped tasks finish; finalizing cancels remaining handles, renders the final
   snapshot, restores terminal state, removes lifecycle listeners, and releases live ownership.

Fatal signal and exception handling skips draining. It attempts finalization for a bounded 250
milliseconds and then re-delivers the original process termination cause even when application work
never settles.

Output write failure disables further rendering rather than changing application task results.
Scoped callback failure marks the task failed and rethrows the original value. Abort signals cancel
their task and are detached during cleanup.

## Quality Attributes

- Maintainability: changes must preserve source-of-truth documents.
- Safety: ordinary text cannot inject terminal control sequences; raw ANSI is explicitly dangerous.
- Boundedness: retention, row limits, flush rate, and backpressure waits are bounded.
- Compatibility: Node.js, ESM, public imports, and event versions follow the library contracts.
- Recovery: cursor state, listeners, and live leases are released on normal close and best-effort
  process lifecycle cleanup.
- Testability: state, rendering, width logic, and fake streams remain independently testable.

## Module Ownership

- `src/runtime.ts`: orchestration, public task handles, capability detection, lifecycle cleanup.
- `src/task-store.ts`: task state, validation, retention, snapshots, aggregate progress.
- `src/renderer.ts`: renderer policy and pure frame construction.
- `src/output-coordinator.ts`: stream writes, backpressure, terminal lease and cleanup.
- `src/events.ts`: public event schema mapping.
- `src/theme.ts` and `src/width.ts`: safe presentation primitives.
