# ADR 0001: prove crawler invariants with a single-host durable frontier

- Status: accepted
- Date: 2026-08-18

## Context

A crawler diagram often begins with “URL frontier = FIFO queue.” FIFO alone cannot express origin politeness, in-flight ownership, worker crash, retry time, recrawl validators, URL identity, or content identity. Building a distributed queue before those semantics are executable would hide the most important decisions behind infrastructure.

## Decision

- Use one SQLite database in WAL mode with `synchronous=FULL` as the authoritative local frontier.
- Persist canonical URL rows, origin active token/cooldown, expiring leases, attempts, validators, outcomes, content objects, robots policies, and fetch receipts.
- Acquire leases under `BEGIN IMMEDIATE`, one origin token at a time.
- Requeue expired leases with an explicit crash cooldown and a visible `lease_expired` reason.
- Keep network I/O outside database transactions. The lease is the recovery boundary.
- Store raw content once per SHA-256 digest but retain every URL row and fetch receipt.
- Use HTTP conditional requests for scheduled recrawl.

## Consequences

- The implementation can be run, killed, reopened, and inspected without an external service.
- SQLite serializes writers; it is not the 800-QPS or multi-machine design.
- `node:sqlite` is available across the tested Node matrix, but Node 22 labels it experimental.
- A lease timeout must exceed robots, cooldown, redirects, page timeout, parsing, and commit time. There is no lease-renewal protocol in v0.1.
- Network I/O after lease acquisition can be repeated after crash. Fetch receipts are at-least-once observations, not exactly-once internet requests.
- WAL/FULL and a process `SIGKILL` receipt do not prove sudden-power-loss, device-cache, directory-entry, backup, or filesystem durability.

## Distributed evolution gate

Moving to PostgreSQL, a queue, or a custom distributed frontier is justified only when there is a real multi-worker requirement. The replacement must preserve:

1. one authoritative active lease and epoch/token per canonical URL;
2. one shared origin cooldown/backoff state across workers;
3. atomic claim/release/recovery transitions;
4. durable URL and content identity without conflation;
5. observable attempt, retry, dead-letter, and recrawl state;
6. sharding that cannot let two schedulers independently police the same origin.

Passing a message queue benchmark without those semantics is not a valid migration.
