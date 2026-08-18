# Operations runbook

## Start

1. Choose a dedicated local state directory with restricted permissions and sufficient disk.
2. Set a truthful, contactable User-Agent before any public crawl; the repository default is test-only.
3. Review seed ownership, terms, robots policy, legal/privacy scope, depth, body limit, retry budget, and retention.
4. Seed a bounded set, inspect `stats`, then run a bounded job count.
5. Monitor frontier states, dead rows, receipts, content bytes, origin backoff, HTTP outcomes, and disk/WAL size.

## Crash recovery

Do not delete lease fields manually. A new scheduler call finds expired leases, releases the exact origin token, records `lease_expired`, applies crash cooldown, and requeues the URL. The runtime smoke kills a process after the lease commit and verifies that the next attempt is number two.

Lease recovery proves application-process behavior only. Preserve the SQLite database plus WAL/SHM files together; no backup/restore procedure is validated here.

## Robots incident

- 2xx parse failure: preserve parseable rules and investigate dependency behavior; do not silently allow all.
- 429/5xx/network without cache: complete disallow and back off the origin.
- Unreachable with cache: current code can use stale policy temporarily, as RFC 9309 permits. Alert if the condition persists.
- Wrong policy observed: stop the origin, retain the robots receipt/cache metadata, fix policy, and only then requeue.

Do not interpret a 404 robots file as permission beyond the protocol; terms, authentication, privacy, and law are separate.

## Origin overload

For `429`, `503`, other server errors, timeouts, or retryable network failures, ensure `next_allowed_at_ms` moves for the origin, not just one URL. Respect bounded `Retry-After`. If dead rows or latency rise, reduce concurrency and crawl budget rather than increasing retries.

## Egress rejection

An unsafe DNS range or redirect is terminal for the current URL. Do not add a broad private-range bypass. The exact-origin exception is only for a loopback fixture and the CLI rejects it outside `NODE_ENV=test`. Production exceptions belong in a reviewed network policy with defense in depth.

## Storage and recrawl

- `contents` stores raw bodies once per SHA-256 digest.
- `frontier` and `fetch_receipts` retain URL-level history; deleting duplicate URLs would destroy provenance.
- Recrawl preserves validators. A 304 without a prior digest is treated as invalid.
- Before adding retention or compaction, define which receipts, robots policies, tombstones, and content references must survive restore.

## Alerts worth adding

- robots complete-disallow rate and stale-policy age;
- egress-policy rejection and DNS failure rate;
- lease expiry, retry exhaustion, and dead frontier growth;
- origin cooldown/backoff distribution and 429/503 rate;
- body-limit, redirect-limit, unsupported encoding/type, parser failures;
- WAL/database/content bytes and available disk;
- conditional recrawl 304 ratio and validator loss.
