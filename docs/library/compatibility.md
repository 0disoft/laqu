# Compatibility

- Status: Active
- Owner: Maintainers

## Runtime

- Supported runtime: Node.js 24 and later within the current major package line.
- Module format: ESM.
- Runtime dependencies: none.
- Bun is a development and validation tool, not a consumer runtime requirement.

Consumers must provide stream-like status targets compatible with the public `StreamTarget`
contract. TTY-specific output requires cursor-capable terminal behavior; CI, pipe, dumb, and
non-TTY targets use plain output under the automatic policy.

## Package Surface

Supported imports are:

- `@0disoft/laqu`
- `@0disoft/laqu/events`
- `@0disoft/laqu/theme`
- `@0disoft/laqu/width`

Deep imports into `dist/` or `src/` are unsupported. TypeScript consumers use declarations emitted
for the same export map. CommonJS `require()` is not a declared package surface.

## Terminal Behavior

Unicode display width varies across terminals. The library guarantees its documented width model,
not pixel-identical layout across every terminal and font. Raw ANSI passed through
`dangerouslyRawAnsi()` is outside normal sanitization and width guarantees.

Process lifecycle hooks are opt-in. Applications that already own signal or exception handling
should call `close()` from their own shutdown path.

## Compatibility Evidence

- `check` covers type checking, lint, format, tests, and build.
- `pack-check` covers package self-reference, TypeScript consumer declarations, and packed files.
- CI runs on the supported Node.js major and installs the locked development toolchain.
- CI also runs the full package and packed-consumer checks on Node.js 22 under Ubuntu as a blocking
  compatibility candidate. This job is evidence for a future minimum-version decision; it does not
  change the published `engines.node` contract by itself.

External terminals and downstream frameworks are not exhaustively certified. Compatibility claims
beyond the fixtures and CI matrix require additional consumer evidence.
