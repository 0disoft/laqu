# Changelog

Notable user-facing changes to `@0disoft/laqu` are recorded here. The project follows
[Semantic Versioning](docs/library/semver.md).

## [1.1.9] - Unreleased

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
- Added a blocking Node.js 22 candidate job without changing the published Node.js 24+ support
  contract.

### Compatibility

- No runtime API or event-schema changes.
- Node.js 24 or newer remains required.

## [1.1.8] - 2026-08-10

### Fixed

- Preserved updates that race an active output flush.
- Stabilized cross-platform PTY resize verification.

### Changed

- Adopted the TypeScript 7 toolchain.

[1.1.9]: https://github.com/0disoft/laqu/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/0disoft/laqu/releases/tag/v1.1.8
