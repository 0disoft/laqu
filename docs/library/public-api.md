# Public API

This document summarizes the public package surface for `@0disoft/laqu`.

## Repository Type Contract

This repository type owns public API surface, package compatibility, semantic versioning, migration guidance, distribution artifacts, and consumer-facing deprecation policy.

## Source of Truth

- Usage and behavior: README.md
- Package exports and runtime entrypoints: package.json
- Implementation source: src/
- Regression coverage: test/
- Consumer checks: test/fixtures/

## Published Imports

- `@0disoft/laqu`
- `@0disoft/laqu/events`
- `@0disoft/laqu/theme`
- `@0disoft/laqu/width`

## Compatibility Contract

- Runtime target: Node.js 24+
- Module format: ESM
- Runtime dependencies: none
- Public declaration files are emitted from the TypeScript build into `dist/`.

## Validation

- Run `bun run check` for routine changes.
- Run `bun run pack:check` when package exports, declarations, files, examples, or distribution behavior changes.

## Review Blockers

- Public exports change without semver and migration notes.
- Compatibility claims lack runtime or consumer evidence.
- Package artifacts drift from documented public API.
