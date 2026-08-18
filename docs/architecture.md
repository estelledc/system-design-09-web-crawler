# Architecture and failure model

## Frontier state machine

```text
new discovery -> queued -> leased -> done
                         ↘ queued (bounded retry / expired lease)
                         ↘ dead   (attempt budget exhausted)

done --next_recrawl_at / explicit force--> queued
```

The URL row owns validators, last status, content digest, final URL, outcome, attempt count, and recrawl time. A content object never replaces that history.

## Lease transaction

Within one `BEGIN IMMEDIATE` transaction, the store:

1. clears orphan origin tokens;
2. releases leases whose deadlines passed and applies crash cooldown;
3. activates due recrawls;
4. selects the highest-priority eligible URL whose origin is idle and cooled down;
5. creates a random lease token, claims the origin, marks the URL leased, and increments attempts;
6. commits before any network request.

Completion verifies both the URL lease and the origin token, writes a receipt/result, releases them, and advances origin cooldown in one transaction. A stale worker cannot complete after another token took ownership.

## Network path

```text
lease
  -> robots fresh? otherwise bounded robots fetch
  -> robots decision
  -> optional robots-to-page cooldown
  -> canonical URL and all DNS answers
  -> public-unicast classification and socket pin
  -> bounded HTTP request
  -> same-origin delayed redirects OR cross-origin requeue
  -> status/content policy
  -> content digest + HTML links
  -> atomic completion and discovery enqueue
```

Conditional recrawl sends `If-None-Match` first when an ETag exists and also carries `If-Modified-Since` when available. RFC precedence remains the origin server's job. A valid 304 produces no body object.

## Failure windows

| Window | Persisted observation | Recovery |
|---|---|---|
| Crash before lease commit | URL remains queued | Another run can lease it |
| Crash after lease, before request | Leased token remains | Deadline recovery requeues after cooldown |
| Crash after remote server handled request | Local result may be missing | URL is fetched again; remote GET is not exactly once |
| Crash after content/result transaction | URL is done and receipt exists | No immediate repeat; scheduled recrawl remains |
| Robots network 5xx without cache | Temporary complete disallow | URL and origin back off; bounded retry |
| Page `429/503` with `Retry-After` | Retry receipt and delay | Entire origin, not only that URL, waits |
| DNS returns mixed public/private answers | No socket is opened | Terminal egress rejection |
| Cross-origin page redirect | Target enqueued; source receipt records redirect | New origin gets its own robots and lease |
| Body exceeds limit | Socket response aborted | Terminal body-limit receipt; no partial content stored |
| Content bytes already stored | URL receipt points to existing digest | URL identity remains queryable |

## Ordering and duplicates

- Frontier URL identity is exact canonical serialized URL, not a target-content hash.
- Queue selection is deterministic priority then readiness then URL among eligible origins; web traversal is not claimed to be global BFS once priority, cooldown, retry, and multiple origins exist.
- A remote request can repeat after crash or timeout. The crawler offers at-least-once fetch attempts.
- Content storage is idempotent by digest. Fetch receipts are append-only observations.
- Discovery UPSERT can reduce depth or raise priority but does not reopen a completed row until recrawl is due.

## Scale-out sketch, not implemented

A distributed version would separate URL/content partitions from a globally consistent origin scheduler. Sharding only by URL hash can put the same origin in multiple scheduler partitions and violate politeness; ownership must be assigned by normalized origin or protected by an origin lease service. Content blobs can live in object storage keyed by digest, while URL metadata and receipts remain independently retained.

The current benchmark intentionally excludes this architecture.
