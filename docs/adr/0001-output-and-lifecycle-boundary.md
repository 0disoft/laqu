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
- Keep process-level signal and exception handling opt-in.
- Bound retained records, flush frequency, and backpressure waits.

## Consequences

Machine-readable caller output remains composable and non-TTY environments remain readable. Live
rendering can degrade safely instead of competing for cursor control. Applications retain shutdown
authority but must call `close()` unless they explicitly enable lifecycle management.

`RuntimeOptions.stdout` documents and validates the reserved caller channel but does not redirect
status output. `ChannelRole` names the channel vocabulary; `statusStream` is the operative routing
option in the current API. A future behavioral role-routing API requires separate public design,
tests, migration assessment, and semantic-version classification.
