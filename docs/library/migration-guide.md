# Migration Guide

- Status: Active
- Owner: Maintainers

## Upgrading to 2.0.0

Only one active runtime can use a status-stream object. Creating a second runtime for the same
stream now throws `LaquOutputError` with code `LAQU_OUTPUT_STREAM_IN_USE`. In 1.x, a second runtime
could fall back to plain output while a live owner was active, which could corrupt the terminal
display. Share one runtime and use child tasks for concurrent work, or pass distinct status streams
to independent runtimes. Close the first runtime before reusing its stream.
Task events also include `ownProgress` alongside aggregate `progress`, so consumers can read direct
counts without interpreting a counter as a percentage. Existing consumers may ignore the new field.

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

There are no documented deprecated APIs or major-version migrations at version 1.1.0. Future
deprecations and breaking changes must be added here with old usage, replacement usage, lifecycle
differences, and the first version containing the change.

Version 1.1.0 makes output failure observable. Callers that previously ignored status-stream write
failure should handle rejection from `flush()` and `close()`. Use `LaquOutputError.code` for stable
classification; task callback success and status-output delivery remain separate outcomes.

## Recovery

If an upgrade changes terminal behavior unexpectedly, select plain progress output while isolating
the terminal-specific difference. If event consumption fails, pin the previous compatible package
version temporarily, compare `LAQU_EVENT_SCHEMA_VERSION`, and migrate before adopting an incompatible
event schema. Package versions are immutable; fixes are delivered in a new release.
