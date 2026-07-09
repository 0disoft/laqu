# AGENTS.md

## Repository Scope

This repository contains `@0disoft/laqu`, a TypeScript library for reliable terminal progress and live CLI rendering on Node.js 24+.

The repository owns library source code, tests, examples, packaging metadata, public documentation, and the scaffold guidance added by `ssealed`.

## Repository Shape

- Primary repository type: library
- Addons: none

As a library, this repository owns public API surface, package compatibility, semantic versioning, migration guidance, distribution artifacts, and consumer-facing deprecation policy.

## Source of Truth

- Public behavior and usage: README.md
- Public package surface: package.json exports and docs/library/public-api.md
- Runtime implementation: src/
- Regression coverage: test/
- Validation: VALIDATION.md
- Agent routing: .agents/context-map.md
- Repository hygiene: .editorconfig, .gitattributes, .gitignore

## Hard Rules

- Preserve Node.js 24+ runtime compatibility.
- Preserve the published ESM package surface in package.json unless the change intentionally updates the public API.
- Keep stdout reserved for caller-owned data and keep progress/status output on stderr unless an API option explicitly changes that behavior.
- Do not add process-level signal or exception handlers by default; lifecycle handling remains opt-in.
- Do not generate application scaffolds, servers, databases, or runtime infrastructure in this library repo.
- Do not invent technology choices or compatibility claims. Use README.md, package.json, source, tests, and release evidence.
- Do not create fake credentials, tokens, secrets, or private values.
- Do not rely on generated, cache, or build output as source truth.

## Repository Hygiene

- .editorconfig sets line ending, encoding, and final newline policy.
- .gitattributes sets Git text normalization and binary diff policy.
- .gitignore excludes local, secret, build, and cache artifacts.
- Generated, cache, and build output must not be used as design-document evidence.
- Do not create large diffs that only change line endings.

## Before Editing

- Read this file, VALIDATION.md, CHECKLIST.md, .agents/context-map.md, package.json, and README.md.
- For public API, packaging, or compatibility changes, read docs/library/public-api.md and .agents/skills/library-package/SKILL.md.
- For bug fixes, read .agents/skills/bugfix/SKILL.md and the relevant checklist named by CHECKLIST.md.
- Confirm the source-of-truth file before changing contracts or public behavior.

## Out of Scope

- Application source scaffolding.
- Runtime infrastructure such as Docker, Kubernetes, Terraform, or framework apps.
- Project-specific credentials or deployment secrets.

## Validation

- Use VALIDATION.md for stable validation names.
- In this workspace, the configured mustflow verification intent is `laqu_check`.
- When working directly inside this repository, `bun run check` is the equivalent package-level verification and covers typecheck, lint, format check, tests, and build.
- Use `bun run pack:check` for package artifact or public export surface changes.

## Final Response Requirements

- List executed validations, passed validations, skipped validations, skip reasons, and remaining risk.
- Name any source-of-truth documents changed.
- Call out public API, package metadata, repository hygiene, and runner changes explicitly.
