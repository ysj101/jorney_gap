# 汐見フィールドステーション

A fictional fieldwork preparation app with two independent, explicit three-step tasks. No real people, observations or sites are used. Notes remain in page memory and are never passed to measurement. The app renders and works with no JourneyGap dependency, with a failed SDK load, and after uninstall.

The optional Vite glob in src/main.ts discovers an installed SDK through its public trackStep API. There are no workspace imports or mandatory SDK dependencies. Milestones are deliberately selected by the app; init does not infer them. This optional adapter is sample code, not something the CLI injects into application logic.

From the repository root, after pnpm install and pnpm build, run `pnpm demo`. It copies this app into a temporary directory, packs the actual SDK, starts a temporary read-only fixture registry and loopback Relay, runs the real CLI init, then starts Vite at http://127.0.0.1:5173/field/. npm downloads public toolchain dependencies without an account. The output gives app/DB/CLI paths for doctor/report/uninstall. Ctrl-C stops the local processes and removes the temporary synthetic app and DB. Ports 4318 and 5173 must be free. Nothing is published or deployed.

To run without instrumentation, `pnpm --filter sample-web dev --host 127.0.0.1`, or `pnpm --filter sample-web build`. Deployment uses /field/ by default; change vite.config.ts and keep the HTML base element for other subpaths. There are no external fonts/images, inline scripts or styles, or unsafe-eval requirements.

`pnpm test:e2e` automatically prepares an independent npm app from this source, runs CLI init twice, builds enabled/disabled/CORS-denied variants, runs uninstall twice, rebuilds, and launches a local Relay/static server. Playwright verifies consent and withdrawal, parallel tasks, privacy, CSP/subpaths/hash routing, load/network failure and bounded app response time. Browser binaries are installed automatically; Linux system dependencies can be installed with `pnpm exec playwright install --with-deps chromium`. Desktop/mobile screenshots in test-results contain only this fictional app and are Git-ignored.
