# Changelog

Notable user-facing changes to `@0disoft/laqu` are recorded here. The project follows
[Semantic Versioning](docs/library/semver.md).

## [Unreleased]

### Fixed

- Reused immutable task snapshots and restricted plain/JSON output comparisons to changed tasks
  and their ancestors, without reducing terminal-task retention or dropping lifecycle records.
- Measured canonically decomposed Hangul using composed syllable widths while preserving the
  original text through clipping and wrapping.

## [2.1.1] - 2026-10-25

Version 2.1.0 was not published: release verification caught a bundled-consumer test path that
older Bun versions interpreted as a package specifier. The fixture now uses an absolute entry path.

### Added

- Added a responsive live ledger with aligned task, progress, count, percentage, and state columns.
- Added the installed version to the live header and optional background stable-version notices
  with bounded requests, a 24-hour cache, and cancellation when runtimes close.

### Fixed

- Validated task updates before mutating lifecycle state and preserved live layout across
  consecutive terminal resizes.
- Bounded grapheme traversal when clipping long terminal text and used a ring buffer for retained
  logs to avoid shifting the full retention window for every new log.
- Released consumed plain and JSON frames and compacted empty queue slots during continuous
  backpressure, preventing processed output from accumulating while the pending queue stays small.
- Skipped full task-tree snapshots during silent and never-output flushes while preserving
  retention, scoped callback results, and explicit stream error reporting.
- Removed the eager grapheme array from line wrapping, reducing temporary allocations when live
  failure diagnostics or callers wrap long strings without changing the rendered text.
- Recalculated tab stops after wrapping and split oversized tab expansions across bounded lines,
  preserving ANSI sequences, wide graphemes, consecutive tabs, and explicit newlines.
- Kept standalone indeterminate symbols consistent between compact and ledger layouts without
  replacing mixed child aggregates with a leaf-task symbol.
- Prioritized failed live tasks and preserved full failure diagnostics in scrollback once per
  changed cause, even when the live row budget or terminal-task retention hides their rows.
- Preserved successful scoped callback results when automatic output flushing or deferred close
  fails. Explicit `flush()` and `close()` still report the sticky output error.
- Cancelled signal-bound manual tasks safely while close drains scoped callbacks, without an
  uncaught exception or relaxing the restriction on caller mutations during shutdown.
- Kept active scoped task records until their callbacks settle, so terminal-record pruning cannot
  replace a late callback failure with `Unknown task id` or leave the summary counting it as a
  success. Normal retention resumes after the callback settles.
- Read error messages once and tolerate throwing prototype checks, preserving original scoped
  failures and terminal status when a caller throws an unusual object or revoked Proxy.

### Compatibility

- Package exports, event schema version `1`, and Node.js 22+ support remain unchanged.
- The new `checkForUpdates` option is backward compatible. Checks are limited to human TTY output
  outside CI and can be disabled with `checkForUpdates: false`.

## [2.0.0] - 2026-09-27

### Added

- Added `LAQU_OUTPUT_WRITE_TIMEOUT` and `LAQU_OUTPUT_STREAM_IN_USE` output error codes.
- Task events now include `ownProgress` with the task's direct count or ratio alongside the existing
  aggregate `progress` field.

### Changed

- A status stream now has one active runtime owner. A second runtime using that stream fails
  immediately; use one runtime with child tasks or separate streams.
- Plain and machine-readable output preserve task creation, terminal transitions, and retained logs
  in mutation order while frequent progress updates may be combined.
- Human output shows direct `current/total` counts or counter values without assigning a percentage
  to counters; parent rows continue to show their child aggregate.
- `flush()` and `close()` wait for laqu's writes to complete on Node.js `Writable` streams.

### Fixed

- Kept the original scoped task error when status output also fails.
- Preserved parent progress when completed child records are pruned and enforced retention in
  silent-output modes.
- Preserved visible text between ST-terminated OSC controls.

### Compatibility

- Concurrent runtimes sharing one status stream no longer fall back to plain output. See the
  [2.0.0 migration guide](docs/library/migration-guide.md).
- Package exports and event schema version `1` remain unchanged.

## [1.1.9] - 2026-08-13

### Added

- Added runnable examples for clean stdout, nested task trees, and versioned NDJSON events.
- Added a terminal preview and direct links to API, compatibility, migration, contribution, and
  security documentation.
- Added contribution guidance, private vulnerability-reporting guidance, and structured GitHub
  issue forms.

### Changed

- Reworked the README around the core workflow: human progress on stderr, caller-owned data on
  stdout, and versioned events for machine consumers.
- Expanded the packed-package consumer check to execute all new examples and require the README
  preview asset in the published tarball.
- Clarified npm search metadata and removed the misleading `tui` keyword.
- Added a blocking minimum-runtime job for Node.js 22.

### Compatibility

- No runtime API or event-schema changes.
- Lowered the minimum supported runtime from Node.js 24 to Node.js 22 after the full package and
  packed-consumer checks passed on main.

## [1.1.8] - 2026-08-10

### Fixed

- Preserved updates that race an active output flush.
- Stabilized cross-platform PTY resize verification.

### Changed

- Adopted the TypeScript 7 toolchain.

[Unreleased]: https://github.com/0disoft/laqu/compare/v2.1.1...HEAD
[2.1.1]: https://github.com/0disoft/laqu/compare/v2.0.0...v2.1.1
[2.0.0]: https://github.com/0disoft/laqu/compare/v1.1.9...v2.0.0
[1.1.9]: https://github.com/0disoft/laqu/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/0disoft/laqu/releases/tag/v1.1.8
