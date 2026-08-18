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

Implementation commit `2f165e01b46125d18688a2415f9b843151310917` passed public GitHub Actions run
[`32157244298`](https://github.com/estelledc/system-design-09-web-crawler/actions/runs/32157244298):

- Node 22.23.2: 21 passed, 0 skipped; crash/politeness receipt passed; 339 lifecycle operations/second;
- Node 24.19.0: 21 passed, 0 skipped; crash/politeness receipt passed; 304 lifecycle operations/second;
- Node 26.7.0: 21 passed, 0 skipped; crash/politeness receipt passed; 356 lifecycle operations/second;
- every job reported zero high-severity-or-greater audit findings.

The smoke receipts observed a real child-process `SIGKILL`, expired-lease recovery with the seed attempt advancing to two,
zero requests to the robots-disallowed path, four completed canonical URLs backed by two unique byte objects, five fetch
receipts, a conditional 304, at least 27.248 milliseconds between same-origin page requests, and no raw crawl identity in
captured logs. These are loopback and single-worker observations, not public-web or distributed-system claims.

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
