# Security policy

Report vulnerabilities through GitHub's private security-advisory flow. Do not include live crawl targets, query strings, resolved IPs, HTML bodies, validators, lease tokens, database files, content digests, or internal network details in a public issue.

## Current controls

- absolute HTTP(S)-only canonical URLs with no embedded credentials;
- public-unicast DNS classification outside exact test origins;
- all DNS answers checked and one approved answer pinned into the socket;
- every redirect parsed and checked; cross-origin page redirects return to the frontier;
- bounded redirects, timeout, URL length, body bytes, link count, depth, retries, and origin cooldown;
- `Accept-Encoding: identity`; encoded bodies are rejected rather than decompressed without a bomb limit;
- raw crawl identity omitted from worker logs;
- SQLite directory/file permissions and parameterized statements.

These controls are application-layer defense, not a complete sandbox. Production requires network egress firewalling, cloud-metadata isolation, DNS controls, proxy policy, TLS/certificate monitoring, abuse/legal review, secret and host hardening, quota enforcement, and incident response. `robots.txt` is a crawler preference protocol, not authentication or authorization.
