# Architecture

Implementation contract: [spec.md](spec.md). Packages are scaffolding until their implementation issues are merged.

`@journeygap/web` will capture consented navigation and explicit journey steps as short OpenTelemetry spans. Its dedicated provider will export standard OTLP/HTTP JSON without changing the application's global provider. `core` owns public types, validation, ordered journey evaluation, and evidence-based analysis. `relay` validates OTLP, stores allowlisted events in SQLite, and optionally reconstructs sanitized OTLP for a configured upstream. `cli` installs/removes a bootstrap and analyzes SQLite or imported OTLP JSONL.

OTLP is a transport, not a common backend query API. Relay and offline import enable analysis independently of a vendor. A static site needs a separate receiver; Relay is a single-process Node.js service, not a browser library or multitenant platform. No LLM, session replay, input capture, automatic application-state inference, or automatic code modification is part of the MVP.
