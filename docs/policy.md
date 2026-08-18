# Crawler policy contract

## Identity and scope

- User-Agent header: `EvidenceCrawler/0.1`.
- Robots product token: `EvidenceCrawler`.
- Current content scope: identity-encoded `text/html`, UTF-8 decoding for extraction, maximum 2 MiB.
- Current traversal scope: configurable seeds, default maximum depth 2, maximum 200 canonical links per HTML page.
- URL identity: WHATWG serialization after restricting scheme/credentials and removing fragments. Query order is preserved because reordering can change server behavior.

The illustrative user agent has no public operator/contact page. It must not be used as-is for public crawling.

## Robots Exclusion Protocol

| robots result | Decision |
|---|---|
| Fresh cached policy under 24h | Use cached policy |
| `2xx` | Parse rules and obey longest matching rule for the crawler token |
| `304` with cached policy | Refresh cache metadata and reuse the policy |
| `4xx` except `429` | Treat as unavailable and allow, as RFC 9309 permits |
| `429`, `5xx`, or network failure with stale cache | Continue using the stale cached policy temporarily |
| `429`, `5xx`, or network failure without cache | Complete disallow and schedule bounded retry |
| Redirect chain | Revalidate every hop; follow at most five, including across authorities |
| Oversized, looping, invalid, or over-limit chain | Fail closed in this implementation |

Successful rules are cached for 24 hours. Temporary unreachable results are retried after a shorter cache window. `Crawl-delay` is not interpreted because it is outside RFC 9309; configured origin cooldown and HTTP backoff remain authoritative.

## Origin politeness

- One `active_lease_token` per origin.
- No next lease until the previous token is released and `next_allowed_at_ms` has passed.
- A fresh robots request and the subsequent page request are separated by the configured cooldown.
- Same-origin redirect hops are separated by the fetcher's redirect delay.
- `429`, `503`, other `5xx`, timeout, and retryable network failures push both the URL and its entire origin into bounded backoff. `Retry-After` is capped at one hour.
- Lease expiry releases the exact active token and adds a crash cooldown before requeue.

This is stricter than a raw FIFO but still a single-host policy. Multiple independent SQLite files would not share politeness state.

## Redirects and egress

- Each URL and redirect hop is parsed again.
- DNS lookup returns all answers. Unless an exact fixture origin is configured, any non-public-unicast answer rejects the request.
- The first approved answer is passed to the actual socket lookup; the HTTP Host header and TLS hostname remain the URL hostname.
- Same-origin redirects can continue inside the current origin lease.
- Cross-origin page redirects are recorded and enqueued as a new URL. They do not borrow the old origin lease.
- Robots redirects may cross authorities as RFC 9309 recommends. The current single worker delays hops, but distributed cross-origin robots scheduling is not implemented.

Application validation cannot replace a network egress policy. The test-origin bypass is gated by environment and exact origin only.

## Content and discovery

- `text/html` is stored as received bytes and keyed by SHA-256.
- A duplicate digest avoids a second body object but produces a distinct URL receipt.
- `parse5` extracts `a` and `area` links, honors the first valid `base`, removes fragments through canonicalization, and deduplicates within the page.
- A `meta name="robots"` directive containing `nofollow` or `none` suppresses link discovery. `X-Robots-Tag`, per-bot meta directives, canonical links, and index/noindex decisions are not implemented.
- A 304 reuses the prior content identity and updates recrawl timing. A 304 without prior content is rejected as an invalid state.

Raw-byte equality is not semantic-page equality. Conversely, two byte variants may represent the same human-visible page; this slice does not perform near-duplicate detection.
