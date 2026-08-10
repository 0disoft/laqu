# Migration Guide

- Status: Active
- Owner: Maintainers

## Upgrading Within 1.x

Read the release notes, keep imports on the documented package root or subpaths, and run the
consumer's type check and representative CLI tests. Existing 1.x public behavior should remain
compatible under the semantic versioning policy.

Applications should always:

- await scoped tasks and `runtime.close()`;
- use `setCompleted()` for absolute progress and `advance()` for a delta;
- leave stdout for application data and use the default stderr status channel or an explicit
  `statusStream`;
- opt into process lifecycle management only when the application does not already own it;
- treat new event fields as ignorable and check the exported event schema version before assuming
  an event representation.

## Deprecated or Breaking APIs

There are no documented deprecated APIs or major-version migrations at version 1.0.10. Future
deprecations and breaking changes must be added here with old usage, replacement usage, lifecycle
differences, and the first version containing the change.

## Recovery

If an upgrade changes terminal behavior unexpectedly, select plain progress output while isolating
the terminal-specific difference. If event consumption fails, pin the previous compatible package
version temporarily, compare `LAQU_EVENT_SCHEMA_VERSION`, and migrate before adopting an incompatible
event schema. Package versions are immutable; fixes are delivered in a new release.
