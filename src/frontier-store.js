import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LeaseError } from './errors.js';
import { canonicalizeUrl, originOf } from './url-policy.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS origins (
  origin text PRIMARY KEY,
  active_lease_token text UNIQUE,
  next_allowed_at_ms integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS frontier (
  url text PRIMARY KEY,
  origin text NOT NULL REFERENCES origins(origin),
  depth integer NOT NULL CHECK (depth >= 0),
  priority integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'done', 'dead')),
  available_at_ms integer NOT NULL DEFAULT 0,
  lease_token text UNIQUE,
  lease_expires_at_ms integer,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  discovered_from text,
  etag text,
  last_modified text,
  last_status integer,
  content_digest text,
  final_url text,
  outcome text,
  last_error text,
  last_fetched_at_ms integer,
  next_recrawl_at_ms integer,
  CHECK (
    (state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    OR (state <> 'leased' AND lease_token IS NULL AND lease_expires_at_ms IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS frontier_ready_idx
  ON frontier (state, available_at_ms, priority DESC, url);

CREATE TABLE IF NOT EXISTS robots_cache (
  origin text PRIMARY KEY REFERENCES origins(origin),
  policy_state text NOT NULL CHECK (policy_state IN ('rules', 'allow_all', 'disallow_all')),
  body text NOT NULL DEFAULT '',
  fetched_at_ms integer NOT NULL,
  expires_at_ms integer NOT NULL,
  status integer,
  etag text,
  last_modified text,
  last_error text
);

CREATE TABLE IF NOT EXISTS contents (
  digest text PRIMARY KEY,
  body blob NOT NULL,
  byte_length integer NOT NULL,
  content_type text NOT NULL,
  stored_at_ms integer NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_receipts (
  id integer PRIMARY KEY AUTOINCREMENT,
  url text NOT NULL,
  final_url text,
  status integer,
  outcome text NOT NULL,
  content_digest text,
  fetched_at_ms integer NOT NULL,
  error_code text
);
`;

function mapFrontier(row) {
  if (!row) return null;
  return {
    url: row.url,
    origin: row.origin,
    depth: Number(row.depth),
    priority: Number(row.priority),
    state: row.state,
    availableAtMs: Number(row.available_at_ms),
    leaseToken: row.lease_token,
    leaseExpiresAtMs: row.lease_expires_at_ms === null ? null : Number(row.lease_expires_at_ms),
    attempts: Number(row.attempts),
    discoveredFrom: row.discovered_from,
    etag: row.etag,
    lastModified: row.last_modified,
    lastStatus: row.last_status === null ? null : Number(row.last_status),
    contentDigest: row.content_digest,
    finalUrl: row.final_url,
    outcome: row.outcome,
    lastError: row.last_error,
    lastFetchedAtMs: row.last_fetched_at_ms === null ? null : Number(row.last_fetched_at_ms),
    nextRecrawlAtMs: row.next_recrawl_at_ms === null ? null : Number(row.next_recrawl_at_ms),
  };
}

export class FrontierStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }

  enqueue(urlValue, { depth = 0, priority = 0, discoveredFrom = null, availableAtMs = 0 } = {}) {
    const url = canonicalizeUrl(urlValue);
    const origin = originOf(url);
    this.#transaction(() => this.#enqueueRow({ url, origin, depth, priority, discoveredFrom, availableAtMs }));
    return this.get(url);
  }

  enqueueMany(urls, options = {}) {
    return this.#transaction(() => {
      let inserted = 0;
      for (const urlValue of urls) {
        const url = canonicalizeUrl(urlValue, options.baseUrl);
        const result = this.#enqueueRow({
          url,
          origin: originOf(url),
          depth: options.depth ?? 0,
          priority: options.priority ?? 0,
          discoveredFrom: options.discoveredFrom ?? null,
          availableAtMs: options.availableAtMs ?? 0,
        });
        inserted += Number(result.changes > 0);
      }
      return inserted;
    });
  }

  leaseNext({ nowMs, leaseMs = 30_000, crashCooldownMs = 1_000 } = {}) {
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs is required');
    return this.#transaction(() => {
      this.db.prepare(
        `UPDATE origins SET active_lease_token = NULL,
           next_allowed_at_ms = max(next_allowed_at_ms, ?)
         WHERE active_lease_token IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM frontier f
             WHERE f.state = 'leased' AND f.lease_token = origins.active_lease_token
           )`,
      ).run(nowMs + crashCooldownMs);
      const crashed = this.db.prepare(
        `SELECT lease_token FROM frontier
         WHERE state = 'leased' AND lease_expires_at_ms <= ?`,
      ).all(nowMs).map((row) => row.lease_token);
      for (const token of crashed) {
        this.db.prepare(
          `UPDATE origins SET active_lease_token = NULL,
             next_allowed_at_ms = max(next_allowed_at_ms, ?)
           WHERE active_lease_token = ?`,
        ).run(nowMs + crashCooldownMs, token);
      }
      this.db.prepare(
        `UPDATE frontier SET state = 'queued', available_at_ms = max(available_at_ms, ?),
           lease_token = NULL, lease_expires_at_ms = NULL, last_error = 'lease_expired'
         WHERE state = 'leased' AND lease_expires_at_ms <= ?`,
      ).run(nowMs + crashCooldownMs, nowMs);

      this.db.prepare(
        `UPDATE frontier SET state = 'queued', available_at_ms = ?, outcome = NULL
         WHERE state = 'done' AND next_recrawl_at_ms IS NOT NULL AND next_recrawl_at_ms <= ?`,
      ).run(nowMs, nowMs);

      const candidate = this.db.prepare(
        `SELECT f.* FROM frontier f JOIN origins o ON o.origin = f.origin
         WHERE f.state = 'queued' AND f.available_at_ms <= ?
           AND o.active_lease_token IS NULL AND o.next_allowed_at_ms <= ?
         ORDER BY f.priority DESC, f.available_at_ms ASC, f.url ASC
         LIMIT 1`,
      ).get(nowMs, nowMs);
      if (!candidate) return null;

      const leaseToken = randomUUID();
      const originClaim = this.db.prepare(
        `UPDATE origins SET active_lease_token = ?
         WHERE origin = ? AND active_lease_token IS NULL AND next_allowed_at_ms <= ?`,
      ).run(leaseToken, candidate.origin, nowMs);
      if (Number(originClaim.changes) !== 1) throw new LeaseError('origin lease changed while selecting');
      const rowClaim = this.db.prepare(
        `UPDATE frontier SET state = 'leased', lease_token = ?, lease_expires_at_ms = ?, attempts = attempts + 1
         WHERE url = ? AND state = 'queued'`,
      ).run(leaseToken, nowMs + leaseMs, candidate.url);
      if (Number(rowClaim.changes) !== 1) throw new LeaseError('frontier row changed while selecting');
      return mapFrontier(this.db.prepare('SELECT * FROM frontier WHERE url = ?').get(candidate.url));
    });
  }

  getRobots(origin) {
    const row = this.db.prepare('SELECT * FROM robots_cache WHERE origin = ?').get(origin);
    if (!row) return null;
    return {
      origin: row.origin,
      policyState: row.policy_state,
      body: row.body,
      fetchedAtMs: Number(row.fetched_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
      status: row.status === null ? null : Number(row.status),
      etag: row.etag,
      lastModified: row.last_modified,
      lastError: row.last_error,
    };
  }

  saveRobots(record) {
    this.db.prepare('INSERT OR IGNORE INTO origins (origin) VALUES (?)').run(record.origin);
    this.db.prepare(
      `INSERT INTO robots_cache (
        origin, policy_state, body, fetched_at_ms, expires_at_ms, status, etag, last_modified, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin) DO UPDATE SET
        policy_state = excluded.policy_state,
        body = excluded.body,
        fetched_at_ms = excluded.fetched_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        status = excluded.status,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_error = excluded.last_error`,
    ).run(
      record.origin,
      record.policyState,
      record.body ?? '',
      record.fetchedAtMs,
      record.expiresAtMs,
      record.status ?? null,
      record.etag ?? null,
      record.lastModified ?? null,
      record.lastError ?? null,
    );
  }

  completeFetched(leaseToken, {
    nowMs,
    cooldownMs,
    status,
    finalUrl,
    contentType,
    body,
    digest,
    etag,
    lastModified,
    links = [],
    maxDepth,
    recrawlAtMs,
  }) {
    return this.#transaction(() => {
      const lease = this.#requireLease(leaseToken);
      const stored = this.db.prepare(
        `INSERT OR IGNORE INTO contents (digest, body, byte_length, content_type, stored_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(digest, body, body.length, contentType, nowMs);
      const outcome = Number(stored.changes) === 1 ? 'fetched_new_content' : 'fetched_duplicate_content';
      this.db.prepare(
        `UPDATE frontier SET state = 'done', lease_token = NULL, lease_expires_at_ms = NULL,
           etag = ?, last_modified = ?, last_status = ?, content_digest = ?, final_url = ?,
           outcome = ?, last_error = NULL, last_fetched_at_ms = ?, next_recrawl_at_ms = ?
         WHERE url = ? AND lease_token = ?`,
      ).run(
        etag ?? null,
        lastModified ?? null,
        status,
        digest,
        finalUrl,
        outcome,
        nowMs,
        recrawlAtMs ?? null,
        lease.url,
        leaseToken,
      );
      this.#receipt(lease.url, finalUrl, status, outcome, digest, nowMs, null);
      if (lease.depth < maxDepth) {
        for (const link of links) {
          this.#enqueueRow({
            url: canonicalizeUrl(link),
            origin: originOf(link),
            depth: lease.depth + 1,
            priority: lease.priority,
            discoveredFrom: lease.url,
            availableAtMs: nowMs,
          });
        }
      }
      this.#releaseOrigin(lease.origin, leaseToken, nowMs + cooldownMs);
      return { outcome, contentStored: Number(stored.changes) === 1, discovered: links.length };
    });
  }

  completeNotModified(leaseToken, { nowMs, cooldownMs, finalUrl, etag, lastModified, recrawlAtMs }) {
    return this.#finish(leaseToken, {
      nowMs,
      cooldownMs,
      status: 304,
      finalUrl,
      outcome: 'not_modified',
      errorCode: null,
      state: 'done',
      recrawlAtMs,
      etag,
      lastModified,
    });
  }

  completeTerminal(leaseToken, { nowMs, cooldownMs, status = null, finalUrl = null, outcome, errorCode = null }) {
    return this.#finish(leaseToken, {
      nowMs, cooldownMs, status, finalUrl, outcome, errorCode, state: 'done', recrawlAtMs: null,
    });
  }

  retry(leaseToken, {
    nowMs,
    cooldownMs,
    delayMs,
    maxAttempts,
    status = null,
    finalUrl = null,
    errorCode,
  }) {
    return this.#transaction(() => {
      const lease = this.#requireLease(leaseToken);
      const dead = lease.attempts >= maxAttempts;
      const state = dead ? 'dead' : 'queued';
      const outcome = dead ? 'retry_exhausted' : 'retry_scheduled';
      this.db.prepare(
        `UPDATE frontier SET state = ?, available_at_ms = ?, lease_token = NULL,
           lease_expires_at_ms = NULL, last_status = ?, final_url = ?, outcome = ?, last_error = ?
         WHERE url = ? AND lease_token = ?`,
      ).run(
        state,
        nowMs + delayMs,
        status,
        finalUrl,
        outcome,
        errorCode,
        lease.url,
        leaseToken,
      );
      this.#receipt(lease.url, finalUrl, status, outcome, null, nowMs, errorCode);
      this.#releaseOrigin(lease.origin, leaseToken, nowMs + cooldownMs);
      return { state, outcome, attempts: lease.attempts };
    });
  }

  forceRecrawl(urlValue, nowMs) {
    const url = canonicalizeUrl(urlValue);
    const result = this.db.prepare(
      `UPDATE frontier SET state = 'queued', available_at_ms = ?, next_recrawl_at_ms = NULL, outcome = NULL
       WHERE url = ? AND state = 'done'`,
    ).run(nowMs, url);
    return Number(result.changes) === 1;
  }

  get(urlValue) {
    return mapFrontier(this.db.prepare('SELECT * FROM frontier WHERE url = ?').get(canonicalizeUrl(urlValue)));
  }

  stats() {
    const states = this.db.prepare('SELECT state, count(*) AS count FROM frontier GROUP BY state').all();
    const counts = Object.fromEntries(states.map((row) => [row.state, Number(row.count)]));
    const content = this.db.prepare('SELECT count(*) AS count, coalesce(sum(byte_length), 0) AS bytes FROM contents').get();
    const receipts = this.db.prepare('SELECT count(*) AS count FROM fetch_receipts').get();
    return {
      frontier: { queued: 0, leased: 0, done: 0, dead: 0, ...counts },
      contents: Number(content.count),
      contentBytes: Number(content.bytes),
      receipts: Number(receipts.count),
    };
  }

  nextReadyAtMs() {
    const row = this.db.prepare(
      `SELECT min(max(f.available_at_ms, o.next_allowed_at_ms)) AS ready_at
       FROM frontier f JOIN origins o ON o.origin = f.origin
       WHERE f.state = 'queued' AND o.active_lease_token IS NULL`,
    ).get();
    return row.ready_at === null ? null : Number(row.ready_at);
  }

  receipts() {
    return this.db.prepare('SELECT * FROM fetch_receipts ORDER BY id').all().map((row) => ({
      id: Number(row.id),
      url: row.url,
      finalUrl: row.final_url,
      status: row.status === null ? null : Number(row.status),
      outcome: row.outcome,
      contentDigest: row.content_digest,
      fetchedAtMs: Number(row.fetched_at_ms),
      errorCode: row.error_code,
    }));
  }

  close() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
    this.db.close();
  }

  #enqueueRow({ url, origin, depth, priority, discoveredFrom, availableAtMs }) {
    if (!Number.isInteger(depth) || depth < 0) throw new TypeError('depth must be a non-negative integer');
    if (!Number.isInteger(priority)) throw new TypeError('priority must be an integer');
    this.db.prepare('INSERT OR IGNORE INTO origins (origin) VALUES (?)').run(origin);
    return this.db.prepare(
      `INSERT INTO frontier (url, origin, depth, priority, discovered_from, available_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         depth = min(frontier.depth, excluded.depth),
         priority = max(frontier.priority, excluded.priority)`,
    ).run(url, origin, depth, priority, discoveredFrom, availableAtMs);
  }

  #finish(leaseToken, {
    nowMs,
    cooldownMs,
    status,
    finalUrl,
    outcome,
    errorCode,
    state,
    recrawlAtMs,
    etag,
    lastModified,
  }) {
    return this.#transaction(() => {
      const lease = this.#requireLease(leaseToken);
      this.db.prepare(
        `UPDATE frontier SET state = ?, lease_token = NULL, lease_expires_at_ms = NULL,
           last_status = ?, final_url = ?, outcome = ?, last_error = ?, last_fetched_at_ms = ?,
           next_recrawl_at_ms = ?, etag = coalesce(?, etag), last_modified = coalesce(?, last_modified)
         WHERE url = ? AND lease_token = ?`,
      ).run(
        state,
        status,
        finalUrl,
        outcome,
        errorCode,
        nowMs,
        recrawlAtMs,
        etag ?? null,
        lastModified ?? null,
        lease.url,
        leaseToken,
      );
      this.#receipt(lease.url, finalUrl, status, outcome, lease.contentDigest, nowMs, errorCode);
      this.#releaseOrigin(lease.origin, leaseToken, nowMs + cooldownMs);
      return { state, outcome };
    });
  }

  #receipt(url, finalUrl, status, outcome, digest, nowMs, errorCode) {
    this.db.prepare(
      `INSERT INTO fetch_receipts (url, final_url, status, outcome, content_digest, fetched_at_ms, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(url, finalUrl, status, outcome, digest, nowMs, errorCode);
  }

  #releaseOrigin(origin, leaseToken, nextAllowedAtMs) {
    const result = this.db.prepare(
      `UPDATE origins SET active_lease_token = NULL,
         next_allowed_at_ms = max(next_allowed_at_ms, ?)
       WHERE origin = ? AND active_lease_token = ?`,
    ).run(nextAllowedAtMs, origin, leaseToken);
    if (Number(result.changes) !== 1) throw new LeaseError('origin lease ownership changed');
  }

  #requireLease(leaseToken) {
    const row = this.db.prepare(
      `SELECT * FROM frontier WHERE state = 'leased' AND lease_token = ?`,
    ).get(leaseToken);
    if (!row) throw new LeaseError('frontier lease is missing or expired');
    return mapFrontier(row);
  }

  #transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
