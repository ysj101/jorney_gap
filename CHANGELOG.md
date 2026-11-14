# Changelog

All notable changes are recorded here using Semantic Versioning. No public release has been made.

## Unreleased

- Add the MVP specification and implementation issue breakdown.
- Establish Node.js 24 / pnpm workspace, four package build boundaries, static checks, smoke tests, and CI.
- Add Apache-2.0 licensing, contribution/security policies, and an operator privacy notice template.

- Add shared precompiled CSP-safe validators, OTLP JSON parsing/privacy reconstruction, and evidence-based journey analysis.
- Add bounded Relay HTTP/CORS/rate/body handling, authenticated aggregate reports, SQLite TTL/quotas, sanitized optional forwarding and pinned local containers.
- Add consent-gated Web SDK, public step/error APIs, private OTel provider/exporter, bounded batching/retries/abort and route-template navigation.
- Add reversible AST-managed init/uninstall, no-secret doctor, bounded JSONL import and standalone text/JSON reports.
- Add an independent Vite sample, npm/pnpm install/build/remove tests, strict-CSP Chromium acceptance and real browser-to-standard-Collector compatibility.
- Add historical secret scanning, dependency audit/license inventory, package-content/checksum verification, workflow lint and a manually approved provenance release workflow.
- Enforce HTTPS for all production upstream endpoints, including loopback addresses.

Migration: SQLite schema v2 adds input-source provenance and saved nonsecret definitions, automatically migrating v1 while retaining rows. Back up before upgrading; older readers cannot read v2. Keep CLI installation manifests to preserve ownership checks. No npm package has been published; package names remain provisional. See docs/releases.md for release/rights checks and future SemVer/schema migration policy.
