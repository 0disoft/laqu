# Changelog

Notable user-facing changes to `@0disoft/laqu` are recorded here. The project follows
[Semantic Versioning](docs/library/semver.md).

## [2.0.0] - Unreleased

### Added

- Added `LAQU_OUTPUT_WRITE_TIMEOUT` and `LAQU_OUTPUT_STREAM_IN_USE` output error codes.

### Changed

- A status stream now has one active runtime owner. A second runtime using that stream fails
  immediately; use one runtime with child tasks or separate streams.
- Plain and machine-readable output preserve task creation, terminal transitions, and retained logs
  in mutation order while frequent progress updates may be combined.
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

[2.0.0]: https://github.com/0disoft/laqu/compare/v1.1.9...v2.0.0
[1.1.9]: https://github.com/0disoft/laqu/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/0disoft/laqu/releases/tag/v1.1.8
