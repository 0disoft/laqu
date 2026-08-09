# Product Brief

- Status: Active
- Owner: Maintainers

## Purpose

`laqu` gives Node.js command-line applications reliable progress reporting without taking ownership
of their data output. It targets applications that need scoped and manual tasks, nested progress,
safe terminal rendering, and machine-readable progress events from one small runtime dependency.

## Source of Truth

- Public behavior: README.md
- Public package surface: package.json and docs/library/public-api.md
- Runtime behavior: src/
- Regression evidence: test/
- Output-boundary decision: docs/adr/0001-output-and-lifecycle-boundary.md

## Required Decisions

- The package owns task state, rendering decisions, terminal coordination, event serialization,
  theming, and display-width helpers.
- The caller owns business data, stdout payloads, application shutdown, and child-process I/O.
- Progress output uses stderr or an explicitly supplied status stream. The package does not write
  caller data to stdout.
- Runtime output failures degrade or stop progress rendering without changing caller task results.
- Process-level lifecycle handling is opt-in.
- Validation before merge follows VALIDATION.md.

## Success Criteria

- Human progress remains readable across TTY, CI, pipe, and dumb-terminal capabilities.
- Machine-readable events remain parseable and versioned.
- Task failure preserves and rethrows the caller's original error.
- Closing restores terminal state and releases listeners and live-stream ownership.
- Long-running commands can bound retained logs and completed task records.

## Non-Goals

- Full-screen terminal UI widgets, input handling, or terminal emulation.
- Owning application data output, process supervision, or child-process execution.
- Supporting Node.js versions below the package engine contract.
- Native addons or runtime dependencies.

## Review Blockers

- The change invents a product domain without a source.
- The change weakens validation or skips required evidence.
- The change relies on generated, cache, or build output as source truth.
