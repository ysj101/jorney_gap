# Security policy

This project is pre-release. Security fixes target the current main branch; there are no supported published releases yet.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/ysj101/jorney_gap/security/advisories/new). If that channel is unavailable, contact the maintainer through the contact method on [their profile](https://github.com/ysj101) to arrange private disclosure. Do not open a public issue with exploit details or credentials. Include affected revisions, a minimal synthetic reproduction, impact, and suggested mitigation if known. No response-time guarantee is currently offered.

Browser endpoints are public and must contain no secrets. Opt-in and data minimization do not guarantee absolute anonymity. CORS is not authentication: public ingest can receive forged telemetry. Deployers must configure TLS, origin restrictions, rate and size limits, retention and disk quotas, monitoring, and separate authenticated administration. IPs may be used temporarily for rate limiting but must not be stored or logged by default. Never expose an admin token to the browser.
