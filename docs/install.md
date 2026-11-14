# Safe Vite + TypeScript integration

The package names are provisional and not published. After an approved release, the one-command interface in the target application's root is:

```sh
npx @journeygap/cli@<version> init --endpoint https://ingest.example.org/v1/traces
```

Source development uses `node /path/to/jorney_gap/packages/cli/dist/main.js init ...` with matching SDK packages available from the selected npm registry. Tests pack the real workspace artifacts into a temporary read-only loopback registry, install them into an independent app with npm and pnpm, typecheck, and build Vite without any package publication or account. `init` does not guess internal application outcomes. Navigation is automatic after consent; call the public trackStep API at app-defined milestones.

Supported targets are standalone npm/pnpm projects with package.json, a declared Vite dependency, tsconfig.json, and exactly one local .ts/.tsx/.mts module script in index.html. Default Vite configuration is supported; a separate vite.config file is optional. Yarn/Bun, ambiguous lockfiles, multiple module entries, out-of-project or symlinked entry/generated files stop before modification. Existing generated paths are never overwritten without their original valid installation manifest.

The command validates the public endpoint first. Production endpoints must be HTTPS; loopback HTTP is accepted for local development. Credentials, query strings, fragments and secret header fields are forbidden. With no endpoint, config is generated with enabled:false and a reserved example.invalid receiver; collection stays off. The service name comes from the package name normalized to schema ID syntax. The two example journeys first-task/second-task each contain started/reviewed/completed and a 30-minute timeout. Replace these definitions deliberately for a real application; they do not infer business state.

## Managed changes

TypeScript AST selects an insertion position after directive prologues and leading imports. Only an explicit `journeygap:managed:start/end` region is added; the original entry is not reprinted or reformatted. Existing application UI, state logic and unrelated uncommitted edits remain intact. The SDK import is a generated sibling bootstrap with a catch-protected dynamic load, so SDK chunk/config failures do not prevent the host from rendering.

Generated files:

- journeygap.config.json: strict JSON with an allowed $comment generation notice, public endpoint, opt-in choice, example routes and journeys.
- journeygap.bootstrap.ts alongside the entry: raw JSON import, public SDK initialization, and a dynamic-load failure boundary. It reads no application state.
- journeygap-env.d.ts alongside the entry: a narrow `*.json?raw` declaration, referenced from the bootstrap. This supports Vite without requiring changes to the user's tsconfig or depending on resolveJsonModule.
- .journeygap-install.json: schema/version marker, entry and exact managed block, SHA256s, before-hashes for package/entry/locks, package-manager selection and dependency ownership. It contains no file backups, credentials or observed events. Keep it with the integration so uninstall can identify owned changes.

The matching SDK dependency is added with the detected npm/pnpm manager, exact version, and lifecycle scripts disabled. A compatible preexisting dependency is retained and is not claimed as CLI-owned; declared but missing dependencies are installed. The app's TypeScript compiler is used when available, otherwise the CLI's compiler, with no emit and temporary build-info output. Dependency or typecheck failure restores preexisting package, lock and source bytes, removes unedited generated files, and reconciles unused dependency cache where possible. Concurrent edits to the entry are preserved while only the owned import block is removed. Filesystem failures that prevent restoration are reported for manual inspection. No git reset, checkout or history rewrite is run.

An exclusive operation lock prevents concurrent JourneyGap modifications. The lock is removed on completion/failure; an unexplained existing lock must be inspected rather than blindly deleted. Review the listed changed paths and git diff --stat before committing. Config is bundled at build time; reload/rebuild after deliberate changes.

## Reruns and configuration review

Identical init reruns leave imports, dependencies and files unchanged. Re-running without an endpoint retains an existing installation's settings. Edited generated files or managed import regions stop with expected/actual hashes and manual inspection instructions. Unrelated edits outside the managed entry block are allowed.

Changing an unedited managed config's endpoint first prints a concrete old/new enabled/endpoint diff and an approval hash, then stops without writing. Review that diff and rerun with the same --endpoint and --approve-config-change HASH. The hash binds the exact current/proposed config, so a stale approval cannot silently authorize another diff. --force never bypasses this review or overwrites user edits. Custom edited configurations must be preserved and integrated manually; the CLI does not silently adopt them as disposable generated files.

Use a public browser-safe OTLP URL. Put any upstream/admin secrets only in the server environment, as described in [deployment](deploy.md). For SDK consent and manual step calls see [Web integration](web.md). Automated uninstall and doctor are implemented in their separate tasks.
