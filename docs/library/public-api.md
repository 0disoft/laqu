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

The package root exports `LaquOutputError` and `LaquOutputErrorCode` so callers can distinguish
status-output delivery failure from application task failure.
Task events expose aggregate `progress` and direct `ownProgress`; the latter retains `current` and
`total` for determinate tasks or `current` for counters.

`RuntimeOptions.checkForUpdates` controls background stable-version notices. Default stderr human
TTY output checks automatically outside CI; custom streams require `true`. `false` disables checks.
Plain, machine-readable, silent, CI, dumb-terminal, and non-TTY output never check. Notices share
the live output coordinator; requests time out after 1.5 seconds, cache successes for 24 hours, and
are cancelled when the last subscribed runtime closes. Checks never block flush or close.
The live ledger header uses the version embedded from package metadata during the build.
Runtime imports do not resolve Laqu's own package or read its package.json, including in bundled CLIs.

## Compatibility Contract

- Runtime target: Node.js 22+
- Module format: ESM
- Runtime dependencies: none
- Public declaration files are emitted from the TypeScript build into `dist/`.
- Detailed compatibility policy: docs/library/compatibility.md
- Semantic versioning policy: docs/library/semver.md
- Upgrade and deprecation guidance: docs/library/migration-guide.md

## Validation

- Run `bun run check` for routine changes.
- Run `bun run pack:check` when package exports, declarations, files, examples, or distribution behavior changes.

## Review Blockers

- Public exports change without semver and migration notes.
- Compatibility claims lack runtime or consumer evidence.
- Package artifacts drift from documented public API.
