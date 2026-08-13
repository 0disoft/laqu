# Contributing to laqu

Thanks for helping make terminal progress reliable across interactive terminals, CI, and pipes.

## Before You Start

- Open a question in the issue tracker for usage help or an early design idea.
- Open a bug report for reproducible defects.
- Open a feature request before investing in a new public API or compatibility change.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Small fixes with a focused test are welcome without prior discussion. Public API, event schema,
output routing, Node.js support, process lifecycle, or terminal ownership changes need an issue
first because they can affect existing CLI consumers.

## Development

Laqu uses Bun as its package manager and task runner, while the published package runs on Node.js
24 or newer.

```sh
bun install
bun run check
bun run pack:check
```

`bun run check` covers type checking, lint, formatting, tests, and the build. `bun run pack:check`
packs the library, installs that tarball into a temporary consumer, verifies ESM and TypeScript
imports, and runs the packaged examples.

## Change Boundaries

- Keep stdout caller-owned. Progress and events use stderr unless a caller supplies another status
  stream explicitly.
- Do not install process signal or exception handlers by default.
- Preserve the ESM exports documented in [`docs/library/public-api.md`](docs/library/public-api.md).
- Add or update tests when behavior changes.
- Update the README when public usage or output behavior changes.
- Do not commit generated `dist/`, `dist-test/`, or coverage output.

## Pull Requests

Keep each pull request focused on one concern. In the description, include:

- the user-visible behavior that changed;
- the relevant issue, specification, or ADR when one exists;
- validation commands and results;
- skipped checks and remaining risk;
- compatibility or migration impact for public contract changes.

Maintainers may ask for a changeset to be split when documentation, runtime behavior, and unrelated
cleanup are combined.
