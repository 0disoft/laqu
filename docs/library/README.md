# Library

- Status: Active
- Repository Type: library

## Repository Type Contract

This repository type owns public API surface, package compatibility, semantic versioning, migration guidance, distribution artifacts, and consumer-facing deprecation policy.

## Source of Truth

- Product behavior: README.md and docs/product/02-spec.md
- Technical ownership: Maintainers
- Runtime boundary: docs/architecture/00-system-boundary.md
- Output decision: docs/adr/0001-output-and-lifecycle-boundary.md

## Required Decisions

- Public API ownership: package.json exports, src/index.ts, and focused entrypoint modules.
- Semantic versioning policy: docs/library/semver.md.
- Runtime and platform compatibility: docs/library/compatibility.md.
- Package artifact and export surface: package.json files, types, and exports fields.
- Deprecation and migration policy: docs/library/migration-guide.md.

## Review Blockers

- Public exports change without semver and migration notes.
- Compatibility claims lack runtime or consumer evidence.
- Package artifacts drift from documented public API.
