# Validation

This document owns stable validation names for `@0disoft/laqu`.

## Validation Source of Truth

- Workspace command intent: `laqu_check`
- Direct package command: `bun run check`
- Package artifact command: `bun run pack:check`

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
