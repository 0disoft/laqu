# Documentation

- Status: Active

## Source of Truth

- Product scope source: docs/product/02-spec.md
- Architecture boundary source: docs/architecture/00-system-boundary.md
- Architecture decisions source: docs/adr/\*.md
- Operational standard source: docs/ops/00-operational-contract.md
- Validation source: VALIDATION.md
- Agent routing source: .agents/context-map.md
- Repository hygiene source: .editorconfig, .gitattributes, .gitignore
- Library public API source: docs/library/public-api.md
- Library semver source: docs/library/semver.md
- Library compatibility source: docs/library/compatibility.md
- Library migration source: docs/library/migration-guide.md

README.md remains the public usage and behavior contract. These documents explain why that
behavior exists and which files must move together when it changes. Source code, tests, package
metadata, and workflow files take precedence when a documentation claim has drifted.
