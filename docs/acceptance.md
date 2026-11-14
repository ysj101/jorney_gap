# MVP acceptance evidence

All automated input is fictional. The local fixture registry serves packed workspace artifacts without an npm account; browser setup installs into a temporary independent Vite app with no workspace imports. The specification remains a design-history document; current implementation/commands are documented in README and the guides.

| Spec test               | Automated evidence                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| T-01 schema             | config.test.ts rejects invalid endpoints, duplicate IDs, invalid definitions and unknown fields       |
| T-02 consent            | client.test.ts checks zero telemetry construction before consent; browser.spec.ts checks zero sends   |
| T-03 refusal/withdrawal | client/transport tests discard buffers and abort; browser refusal/withdrawal keeps host usable        |
| T-04 privacy            | config/otlp/client privacy tests plus real browser notes/query/fragment assertions                    |
| T-05 parallel journeys  | analyze/client tests plus browser parallel instances and Collector cohorts                            |
| T-06 order/duplicates   | analyze and storage deduplication/out-of-order fixtures                                               |
| T-07 timeout            | analyze/offline fixtures distinguish timeout, pending and insufficient evidence                       |
| T-08 failure/limits     | transport/forward/relay tests bound queues/retries; browser blocked SDK, CORS and stopped Relay       |
| T-09 standard OTLP      | collector.spec.ts receives actual official SDK output in pinned standard Collector                    |
| T-10 upstream switch    | collector.spec.ts replays identical SDK envelopes to a replacement OTLP receiver and compares reports |
| T-11 init twice         | init.test.ts, actual npm/pnpm integration and real CLI browser setup                                  |
| T-12 uninstall/build    | actual npm/pnpm init→build→uninstall×2→build, plus rebuilt browser operation                          |
| T-13 edited files       | init/uninstall tests preserve edited generated files, unmanaged entry changes and dependencies        |
| T-14 static/CSP         | built Vite /field/ with hash routing and strict CSP without unsafe-eval/inline scripts                |
| T-15 admin              | admin/relay tests reject missing/bad tokens and expose aggregates only                                |
| T-16 low samples        | analyze/report fixtures limit confidence and avoid causal claims                                      |
| T-17 cloud independence | all tests use local Relay, SQLite, temporary registry and standard Docker Collector                   |
| T-18 public fixtures    | CI uses synthetic fixtures and fixed dummy local credentials; no external account secrets             |

Run pnpm install --frozen-lockfile, pnpm build, pnpm test and pnpm test:e2e from a clone. Browser binaries are prepared by the E2E command; Linux system dependencies use playwright install --with-deps chromium as in CI. test:e2e starts its own Relay. test:collector additionally needs the disposable local Collector and environment variables in [deployment instructions](deploy.md). The separate CI containers job runs it automatically. The offline fixture covers 40 attempts and exact rates/timings, while Collector acceptance sends 20+ real browser trials with original exporter timestamps. Diagnostic limits, delivery/sampling loss, clock skew and small cohorts remain visible in reports.
