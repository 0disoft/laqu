# ADR 0001: Output and Lifecycle Boundary

- Status: Accepted
- Date: 2026-08-09

## Context

CLI progress can corrupt machine-readable stdout, collide when multiple renderers control one
terminal, and interfere with application-owned signal handling. The library must work in TTY, CI,
pipe, and dumb-terminal environments without becoming a process supervisor.

## Decision

- Reserve stdout for caller-owned data and send status output to stderr by default.
- Allow an explicit status stream without treating a `stdout` option as an automatic output route.
- Select human live rendering only when format, policy, and stream capability permit it.
- Give a stream at most one live owner; concurrent runtimes fall back to append-only output.
- Route logs and progress through one output coordinator.
- Preserve ordered plain and machine-readable output under backpressure; keep only the latest live
  screen while retaining its scrollback.
- Bound pending output and expose timeout, stream, write, and overflow failures through a stable
  `LaquOutputError` code.
- Keep process-level signal and exception handling opt-in.
- Keep ordinary `close()` graceful, but use bounded abortive finalization for fatal process events.
- Bound retained records, flush frequency, and backpressure waits.

## Consequences

Machine-readable caller output remains composable and non-TTY environments remain readable. Live
rendering can degrade safely instead of competing for cursor control. Applications retain shutdown
authority but must call `close()` unless they explicitly enable lifecycle management.

The runtime lifecycle is `open → draining → finalizing → closed`. Draining admits completion work
only from scoped task trees that were already running. Fatal events skip draining so an unfinished
application task cannot capture `SIGINT`, `SIGTERM`, an uncaught exception, or an unhandled
rejection indefinitely.

`RuntimeOptions.stdout` documents and validates the reserved caller channel but does not redirect
status output. `ChannelRole` names the channel vocabulary; `statusStream` is the operative routing
option in the current API. A future behavioral role-routing API requires separate public design,
tests, migration assessment, and semantic-version classification.

`write()` returning `false` means the current chunk was accepted but later writes must wait for
drain. Subsequent plain and JSON frames therefore remain queued in order. A missing drain contract,
deadline, stream failure, or queue overflow is explicit failure rather than permission to discard
output silently.
