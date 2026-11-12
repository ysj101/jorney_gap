# Contributing

Use Node.js 24+ and pnpm 10.30.2. Follow the source build commands in README. Run build, typecheck, lint, test, and audit before opening a PR. New behavior needs relevant tests; use synthetic data only. Browser and Collector acceptance checks will join CI when implemented.

Open a focused issue describing the expected behavior and relevant section of docs/spec.md. Implement one issue per PR and include `Closes #<number>`, the resulting behavior, and validation. Keep public event schemas and existing APIs backward compatible; breaking changes require a major version. Do not add replay, input capture, or vendor-specific mandatory APIs.

Never commit secrets, authenticated URLs, real traces, user data, databases, or local environment files. Browser configuration contains only public values. Server environment variables carry secrets. Report vulnerabilities privately using SECURITY.md.

Contributions are licensed under Apache-2.0. Check dependency licenses and security advisories before adoption. Do not add a dependency with incompatible redistribution terms.

## Versioning and migrations

Use SemVer and document changes in CHANGELOG.md. During 0.x, document any breaking API change explicitly. Schema version 1 remains backward compatible; a breaking schema requires a new major package version and schema version. Every breaking release must include old/new examples, a migration procedure, storage migration and rollback instructions, and compatibility limits. SQLite migrations must be versioned and tested on existing data, with a backup recommended before upgrades. No migration is currently needed because no packages or schema have been released.

## Release gates

Publishing and actual deployment are separate from implementing and merging PRs. Before publishing, verify npm scope/name availability and trademark rights, audit dependencies and licenses, run all CI checks including E2E and Collector compatibility, confirm synthetic fixtures and no secrets, review privacy documentation and migrations, and obtain release approval. The release workflow must use protected environment approval and provenance. Do not assume provisional package names are reserved.
