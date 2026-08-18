# Threat model

## Assets and boundaries

- Assets: host network boundary, crawl availability, frontier integrity, robots compliance, stored content, URL/receipt metadata, disk capacity, and operator identity.
- Untrusted: seeds, discovered URLs, DNS, redirects, HTTP headers/status/body, HTML, robots files, and remote timing.
- Trusted for this slice: local SQLite file/directory, runtime dependencies, configured clock, and exact loopback fixture exception.

| Threat | Failure | Implemented control | Still required |
|---|---|---|---|
| SSRF to loopback/private/metadata | Internal data or credential access | HTTP(S), no userinfo, all DNS answers classified, socket IP pinned, redirects rechecked | Network firewall/proxy and cloud metadata isolation |
| DNS rebinding / TOCTOU | Validation sees public IP, socket reaches private IP | Approved answer supplied to socket lookup | Trusted resolver, DNS monitoring, network deny rules |
| Cross-origin redirect bypass | New host fetched under old policy | Page redirect becomes new frontier URL | Distributed origin ownership before scale-out |
| Robots unreachable | Crawl despite undefined policy | Complete disallow without cache; stale policy may continue | Operator policy for prolonged outage |
| Spider trap | Infinite URLs/depth | URL/body/link/depth/retry/redirect bounds | Domain quotas, pattern detection, budget controller |
| Decompression bomb | Memory/CPU exhaustion | Request identity encoding; encoded body rejected | Bounded streaming decompressor if compression is added |
| Malformed HTML | Parser crash or excessive work | Mature parser, body/link limits, exception containment | CPU/time isolation and parser security updates |
| Slow server | Worker/lease exhaustion | Request timeout and bounded attempts | Lease renewal or timeout/lease proof for larger bodies |
| Retry storm | Origin overload | One active token, origin-wide backoff, capped Retry-After | Fleet-wide backpressure and circuit breaking |
| Content collision/tamper | Wrong dedup identity | SHA-256 raw-byte digest | Authenticated storage, integrity scrub, collision response |
| Sensitive crawl logs | URL/query/content disclosure | Low-cardinality outcome logs only | Central telemetry governance and access controls |
| Disk growth | Host exhaustion | Explicit body/depth bounds | Storage quotas, retention, compaction, monitoring |

Robots rules do not protect confidential resources and do not grant legal permission. A public deployment needs a named operator, contact policy, terms/privacy review, takedown process, and jurisdiction-specific decisions outside this code.
