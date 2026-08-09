# Project Invariants

- Status: Active

## Contract

The following invariants must remain true across implementation, tests, documentation, package
metadata, and release behavior:

- stdout remains caller-owned unless a caller explicitly supplies it as the status stream.
- Process-level signal and exception handling remains opt-in.
- A stream has at most one live renderer owner.
- Task terminal states are not overwritten by ordinary updates.
- Scoped callback failures preserve the original rejection and task cleanup still runs.
- Public text is sanitized; raw ANSI requires the named dangerous API.
- Retained output state and backpressure waits remain bounded.
- Event schemas are versioned and JSON output remains parseable.
- Public exports, declarations, consumer fixtures, README, and compatibility documentation move
  together.
- Generated `dist/` output is evidence produced by validation, not design authority.

## Required Evidence

- Behavior source of truth: README.md and src/
- Package source of truth: package.json and docs/library/public-api.md
- Owner: Maintainers
- Merge-blocking validation: VALIDATION.md
- Related checklist: CHECKLIST.md

## Review Blockers

- A change bypasses the source of truth.
- A change weakens validation or hides skipped checks.
- A change lacks failure, recovery, security, performance, or test evidence where relevant.
- A public contract changes without compatibility classification and migration guidance.
