# Semantic Versioning

- Status: Active
- Owner: Maintainers

`@0disoft/laqu` follows Semantic Versioning for its published package.

## Public Compatibility Surface

The compatibility surface includes:

- package root and documented subpath exports;
- exported runtime values, TypeScript types, method signatures, and option meanings;
- task lifecycle, output-channel, renderer-selection, and close behavior documented in README.md;
- JSON and NDJSON event fields and schema version;
- supported Node.js range and ESM module format;
- documented theme and width behavior.

## Version Classification

- Patch: compatible fixes, documentation corrections, internal refactors, and new tests that do not
  alter public behavior.
- Minor: backward-compatible exports, options, event fields, or capabilities. New event fields must
  remain safely ignorable by existing consumers.
- Major: removed or renamed exports, narrower accepted inputs, changed defaults or lifecycle
  semantics, event incompatibility, removal of a supported runtime, or module-format changes.

Raising the minimum Node.js version or changing an event in a way that existing consumers cannot
ignore requires a major release. A new incompatible event representation requires a new exported
schema version and migration guidance.

## Deprecation

When practical, deprecate a public API in a minor release before removal in a major release. Mark
the declaration, document the replacement, preserve behavior during the deprecation window, and add
the transition to docs/library/migration-guide.md.

Internal files not reachable through package exports are not public API. Generated declarations and
packed contents must nevertheless remain synchronized with the declared public surface.
