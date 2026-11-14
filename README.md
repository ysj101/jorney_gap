# JourneyGap

JourneyGap observes application-defined journeys using OpenTelemetry traces and reports observed progress, missing steps, and uncertainty. It is an independent Apache-2.0 OSS project. It does not record sessions, input text, or all clicks, and cannot infer an application's business outcomes without explicit `trackStep()` calls.

## Development status

Pre-release implementation. The `@journeygap/*` names are provisional and the packages are **not published**. Shared validation, privacy filtering, journey analysis, the Relay, and the internal Web OTLP transport are implemented. Web consent/navigation, CLI, and browser acceptance tests are being implemented in the [issue tracker](https://github.com/ysj101/jorney_gap/issues). The full contract is in [docs/spec.md](docs/spec.md).

## Build from source

Requires Node.js 24+ and pnpm 10.30.2:

```sh
git clone https://github.com/ysj101/jorney_gap.git
cd jorney_gap
npm install --global pnpm@10.30.2
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm audit
```

Build before tests: package smoke tests resolve the actual generated ESM exports and declarations. `packages/core` provides configuration validation, OTLP sanitization, and analysis; see [configuration](docs/configuration.md), [event schema](docs/event-schema.md), and [analysis](docs/analysis.md). `relay` provides [SQLite storage](docs/storage.md) and [local HTTP ingestion](docs/deploy.md). `web` and `cli` currently provide build scaffolding. Generated artifacts are excluded from Git.

## Intended integration

The following commands describe the target interface; they are not available yet:

```sh
npx @journeygap/cli@<version> init --endpoint https://ingest.example.org/v1/traces
npx @journeygap/cli@<version> doctor
npx @journeygap/cli@<version> import --input ./traces.jsonl --db ./data/journeygap.db
npx @journeygap/cli@<version> report --db ./data/journeygap.db --journey first-task --days 7
npx @journeygap/cli@<version> uninstall
```

The SDK will require opt-in consent before initializing telemetry. Navigation is automatic; meaningful steps require the application API. Change the public `otlpTracesEndpoint` to select an OTLP/HTTP JSON receiver. Never put authentication headers or tokens in browser configuration. A server-side Relay or Collector is needed for secret upstream credentials; static hosting cannot run Relay. Analysis reads local SQLite or imported OTLP JSONL without a cloud account. Delivery is best effort and missing observations do not prove abandonment.

The independent Vite example, local deployment configuration, and complete install/build/uninstall walkthrough will be added with their implementations. See [architecture](docs/architecture.md) and the [operator privacy template](docs/privacy.md).

## Project policies

See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), [Code of Conduct](CODE_OF_CONDUCT.md), [CHANGELOG](CHANGELOG.md), and [LICENSE](LICENSE). Package publication and real deployments require separate authorization and release checks.
