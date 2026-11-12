# Privacy and operator notice template

JourneyGap is designed for opt-in, minimal telemetry. This document describes the implementation target, not deployed functionality. Operators must adapt the template to their actual setup, jurisdiction, processors, and retention policy before enabling collection.

## Example notice (replace bracketed fields)

With your permission, [site operator] collects observations of page route categories and the application steps [list actual journeys] to measure observed progress and detect steps with missing observations. You may accept or reject equally and withdraw through [consent control location]. Before consent, the SDK sends no telemetry. Withdrawal stops new telemetry and clears the pending buffer; records already received expire according to the retention policy below.

Events contain random event IDs, a tab-scoped session ID, journey attempt IDs, declared step/route IDs, timestamps, schema version, and [list any actual allowlisted low-cardinality app attributes and app version]. Session IDs are pseudonymous, not guaranteed anonymous. They are created after consent in sessionStorage. Only your consent preference is kept in localStorage. No input text, full URL/query, dynamic fragment identifier, cookie, account ID, full user agent, stack trace, or network body is collected by JourneyGap.

Telemetry is sent to [receiver and operator], and optionally forwarded to [processors and locations]. Server-side rate limiting may temporarily use IP addresses; JourneyGap does not persist them or log them by default. Separately document any reverse-proxy/provider access logs and their retention. Do not claim that those systems never receive IPs.

Records are retained for [retention period; Relay target default is 14 days], then deleted. Aggregated reports show observed counts and timing, not individual public histories. Failed delivery, sampling, consent withdrawal, or a closed browser can cause missing events; these observations do not prove why a person stopped. Contact [privacy contact] for questions and applicable access/deletion requests. [Describe lawful basis, rights, and international transfers appropriate to your operation.]

## Operator configuration

Keep admin tokens and upstream credentials on the server. Restrict origins, use TLS, rate/size/storage limits, retention cleanup, authenticated administration, and proxy logging policies. Public ingest can be forged; CORS does not authenticate senders. Document any external collector configuration that changes the collection or storage behavior. Never use production user data in fixtures, screenshots, or CI logs.
