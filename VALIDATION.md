# Validation

This document owns stable validation names for `@0disoft/laqu`.

## Validation Source of Truth

- Workspace command intent: `laqu_check`
- Direct package command: `bun run check`
- Package artifact command: `bun run pack:check`
- Optional local benchmark intent: `laqu_bench_quick` (`bun run bench:quick`)

## Standard Validation Names

- format
- lint
- typecheck
- test
- build
- pack-check
- docs
- check

## Required Final Report

Final responses must list executed validations, passed validations, skipped validations, skip reasons, and remaining risk.

## Runner Policy

The `ssealed` scaffold was adopted with runner `none`, so ssealed does not own package scripts.
The project-owned runner surface is package.json scripts.

## Hygiene Validation

Repository hygiene file changes must check line-ending churn, binary diff pollution,
tracked secret files, ignored build/cache artifacts, and generated-output drift.

## Required Validation

- Routine source, test, docs, and scaffold changes: `laqu_check` or `bun run check`.
- Public export, package metadata, dist artifact, or release surface changes: `bun run pack:check` after `bun run check`.
- Scaffold provenance changes: `ssealed doctor . --json`.

## Repository Shape

library validation must protect public API compatibility, runtime compatibility, package exports, generated declarations, and consumer fixture behavior.

## Local Failure Preservation Checks — 2026-10-12

- `a76ad8b` retains an active scoped task until its callback settles. Six regression cases failed
  before the fix; eight final cases also cover an already-aborted scope and release back to normal
  retention. Human, JSON, NDJSON, silent, and never-output modes preserve the original failure.
- `39b1ef4` reads an Error message once and handles throwing prototype checks. Three new cases
  preserve scoped/manual failure status and original rejection values without serializing private
  error objects. A test-harness correction avoids `assert.rejects` inspecting a revoked Proxy.
- Final `bun run check`: typecheck, lint, format, build passed; 149 tests passed, zero failed, one
  skipped because the Windows ConPTY harness was unavailable (150 total). Environment: Windows,
  Node.js 24.18.0, Bun 1.4.2. This run does not establish Node.js 22 or other OS compatibility.
- Final `bun run pack:check` passed with both fixes: a local `@0disoft/laqu@2.0.0` tarball, offline
  install into an independent consumer, strict TypeScript consumer check, all four public imports,
  three examples, late failure recovery, error-inspection recovery, and status-stream reuse.
- No version bump, public export or event-schema change, dependency, CI, or hygiene changes.
  No push, registry publication, or deployment. Live terminal and remote CI checks remain separate.
