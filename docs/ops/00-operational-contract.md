# Operational Contract

- Status: Active

## Operational Contract

`laqu` is an in-process library and does not operate a hosted service. Service SLO, RTO, and RPO do
not apply. Operational responsibility is limited to CI, package publication, release evidence,
dependency maintenance, and consumer-facing remediation.

Critical release journey:

1. A maintainer prepares a package version and matching `v<version>` tag.
2. CI verifies the source, tests, build, consumer fixtures, and dry package contents.
3. The protected npm environment approves publication.
4. The workflow packs once, retains that tarball as an artifact, publishes the same tarball with
   provenance, and creates a GitHub Release.

## Owners

- Primary owner: repository maintainers.
- Publication authority: maintainers approved by the GitHub `npm` environment.
- Escalation path: repository security or issue reporting channels appropriate to the incident.

## Validation

- Required validation names: VALIDATION.md
- Release blockers: version/tag mismatch, failing checks, package-content drift, missing provenance
  authority, unavailable protected environment approval, or an unresolved compatibility break.
- Recovery: npm versions are immutable. Stop or deprecate a bad version when appropriate, repair on
  a new version, rerun the full release workflow, and document consumer migration when compatibility
  is affected.
- External-state limitation: trusted-publisher, environment protection, and registry state must be
  checked in GitHub and npm; repository files cannot prove those settings are currently active.

## Dependency Tiers

- Runtime: Node.js 24+ standard library only; no third-party runtime dependencies.
- Build and validation: Bun, TypeScript, OXC formatter/linter, npm packaging, and GitHub Actions.
- Publication: GitHub Actions OIDC, npm Trusted Publisher, and GitHub Releases.
