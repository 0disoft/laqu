# Product Specification

- Status: Active
- Owner: Maintainers

## Purpose

This specification defines the behavior that the public API, implementation, tests, examples, and
package documentation must preserve.

## Source of Truth

- Usage and public behavior: README.md
- API and package exports: package.json and docs/library/public-api.md
- Runtime implementation: src/runtime.ts
- State model: src/task-store.ts
- Rendering and output: src/renderer.ts and src/output-coordinator.ts
- Event schema: src/events.ts
- Regression evidence: test/

## Required Decisions

### Runtime and Tasks

- `createLaqu()` and `createProgressRuntime()` create equivalent progress runtimes.
- Scoped tasks succeed when their callback resolves, fail and rethrow when it rejects, and preserve
  an aborted task as cancelled.
- Manual task handles support absolute, delta, ratio, percent, indeterminate, message, detail,
  success, failure, cancellation, skip, and child-task operations.
- Task progress rejects invalid numeric inputs and aggregates children by non-negative weight.
- Once close begins, the runtime rejects new mutations and waits for active scoped tasks.

### Output and Rendering

- Status, log, human, JSON, and NDJSON output uses stderr by default; stdout remains caller-owned.
- Renderer selection treats format, stream capability, and progress policy as independent inputs.
- Automatic live rendering requires a human format on a non-CI TTY. Other automatic cases use
  append-only output.
- At most one runtime owns live rendering for a stream. A concurrent runtime falls back to plain
  output until the live owner closes.
- Logs pass through the output coordinator so they cannot corrupt the live region.
- Backpressure is bounded; cleanup restores cursor state and releases stream ownership.

### Events, Retention, and Presentation

- JSON events use the versioned `laqu.event` schema. JSON format closes as one array; NDJSON emits
  newline-delimited objects.
- Optional event fields are omitted when absent. Summary counts survive terminal-task pruning.
- Log and terminal-task retention default to 1,000 records each and accept bounded non-negative
  overrides.
- Ordinary text is sanitized. Raw ANSI requires `dangerouslyRawAnsi()`.
- Width helpers preserve grapheme and ANSI boundaries and account for CJK, emoji, combining marks,
  tabs, and configurable ambiguous width.

### Lifecycle and Compatibility

- Process signal and exception handlers are disabled by default and available only through
  `manageProcessLifecycle: true`.
- The runtime target, module format, dependency policy, and subpath exports follow
  docs/library/compatibility.md and docs/library/public-api.md.
- Validation before merge follows VALIDATION.md.

## Acceptance Evidence

- Unit and integration coverage in test/ exercises task state, renderer selection, output routing,
  backpressure, lifecycle cleanup, event serialization, retention, themes, and width handling.
- Consumer fixtures in test/fixtures/ exercise ESM runtime imports and TypeScript declarations.
- Package and release workflows must run the checks declared in VALIDATION.md.

## Review Blockers

- The change invents a product domain without a source.
- The change weakens validation or skips required evidence.
- The change relies on generated, cache, or build output as source truth.
- Public behavior changes without synchronized tests, README, and compatibility assessment.
