# Verification record

## Gate

`npm run check` executes:

1. syntax, portable-path, local-link, secret-pattern, skipped-test, required-artifact, and pinned-Action checks;
2. deterministic unit and loopback-network tests;
3. a child-process `SIGKILL`, lease recovery, real robots/page crawl, politeness timing, byte dedup, and 304 smoke;
4. a single-host SQLite WAL frontier benchmark with an explicit lifecycle floor;
5. `npm audit --audit-level=high`.

## Tested behaviors

- URL normalization, fragment identity, invalid schemes/credentials/controls/size;
- IPv4/IPv6 public, private, loopback, link-local classification and mixed-answer fail-closed behavior;
- DNS pinning into a real HTTP socket, redirect delay, cross-origin handoff, body abort, and Retry-After cap;
- robots longest match, 24-hour cache, 4xx allow, 429/5xx/network complete disallow, stale-cache fallback, and bounded retry;
- per-origin lease exclusion, cooldown, origin-wide backoff, priority, expiry recovery, attempts, content dedup, receipts, and validator preservation;
- first valid HTML base, link canonicalization/dedup/bounds, and meta nofollow;
- real loopback discovery where a robots-disallowed path receives zero requests;
- process death after lease commit, later lease recovery, same-origin request gaps, duplicate content, persisted reopen, and conditional 304.

No test is skipped. CI runs the same locked gate on Node 22, 24, and 26.

## Current receipts

The initial public CI receipt is pending repository publication. Replace this sentence only after the GitHub run is green.

## Evidence boundary

Passing the gate does not prove:

- full robots-parser RFC 9309 conformance or public-site policy compliance;
- network-layer SSRF isolation, DNS trust, legal permission, or responsible public identity;
- compressed/other-charset HTML, JavaScript rendering, sitemap, `X-Robots-Tag`, canonical links, near-duplicate detection, ranking, or search indexing;
- lease renewal, multiple workers/processes, fleet-wide origin ownership, distributed queue, sharding, or multi-region behavior;
- sudden-power-loss SQLite durability, backup/restore, retention/compaction, production capacity, deployment, SLA, or external acceptance.

## Reproduce

```sh
npm ci --ignore-scripts
npm run check
```

The benchmark uses a temporary on-disk SQLite database in WAL/FULL mode, batches 10,000 URL enqueues, and completes 2,000 lease lifecycles. Its floor is a regression tripwire for this runner, not a scenario throughput claim. It excludes every public-network cost.
