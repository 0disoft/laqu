# ADR 0002: Exclusive Status Stream Ownership

- Status: Accepted
- Date: 2026-09-27

## Context

ADR 0001 let a second runtime fall back to plain output while a first runtime rendered live on the
same stream. The live frame has no trailing newline. Plain output can join that frame and then be
erased by the live runtime's next redraw. Separate output coordinators also cannot order their
writes under backpressure.

## Decision

One active runtime owns a status-stream object. Creating another runtime with that same stream
throws `LaquOutputError` with code `LAQU_OUTPUT_STREAM_IN_USE`. Ownership is released on close and
on construction failure. Applications should share one runtime and create child tasks, or provide
separate status streams when independent runtimes are needed.

## Consequences

Concurrent use of one status stream now fails immediately instead of producing ambiguous terminal
or machine-readable output. This changes the documented 1.x fallback behavior and requires a major
version with migration guidance. The rule is based on stream object identity; callers remain
responsible for coordinating distinct wrappers around the same underlying destination.
