import assert from 'node:assert/strict';
import test from 'node:test';
import { FrontierStore } from '../src/index.js';

function fetched(store, lease, {
  nowMs = 100,
  body = Buffer.from('<p>same</p>'),
  digest = 'a'.repeat(64),
  links = [],
} = {}) {
  return store.completeFetched(lease.leaseToken, {
    nowMs,
    cooldownMs: 10,
    status: 200,
    finalUrl: lease.url,
    contentType: 'text/html',
    body,
    digest,
    etag: '"v1"',
    lastModified: 'Tue, 18 Aug 2026 00:00:00 GMT',
    links,
    maxDepth: 2,
    recrawlAtMs: nowMs + 1_000,
  });
}

test('frontier canonicalizes URL identity and leases only one task per origin', () => {
  const store = new FrontierStore();
  store.enqueue('https://example.com/a#one');
  store.enqueue('https://example.com/a#two', { priority: 5 });
  store.enqueue('https://example.com/b');
  const lease = store.leaseNext({ nowMs: 0, leaseMs: 100 });
  assert.equal(lease.url, 'https://example.com/a');
  assert.equal(lease.priority, 5);
  assert.equal(store.leaseNext({ nowMs: 0, leaseMs: 100 }), null);
  fetched(store, lease, { nowMs: 1 });
  assert.equal(store.leaseNext({ nowMs: 10, leaseMs: 100 }), null);
  assert.equal(store.leaseNext({ nowMs: 11, leaseMs: 100 }).url, 'https://example.com/b');
  store.close();
});

test('expired lease recovery releases exactly the origin token and preserves attempts', () => {
  const store = new FrontierStore();
  store.enqueue('https://example.com/a');
  const first = store.leaseNext({ nowMs: 0, leaseMs: 10, crashCooldownMs: 5 });
  assert.equal(first.attempts, 1);
  assert.equal(store.leaseNext({ nowMs: 10, leaseMs: 10, crashCooldownMs: 5 }), null);
  const recovered = store.leaseNext({ nowMs: 15, leaseMs: 10, crashCooldownMs: 5 });
  assert.equal(recovered.url, first.url);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.lastError, 'lease_expired');
  store.close();
});

test('content bytes deduplicate while URL receipts and identities remain separate', () => {
  const store = new FrontierStore();
  store.enqueue('https://a.example/page');
  store.enqueue('https://b.example/copy');
  const first = store.leaseNext({ nowMs: 0 });
  assert.equal(fetched(store, first).outcome, 'fetched_new_content');
  const second = store.leaseNext({ nowMs: 100 });
  assert.equal(fetched(store, second, { nowMs: 101 }).outcome, 'fetched_duplicate_content');
  const stats = store.stats();
  assert.equal(stats.contents, 1);
  assert.equal(stats.frontier.done, 2);
  assert.equal(stats.receipts, 2);
  assert.equal(store.receipts()[0].url === store.receipts()[1].url, false);
  store.close();
});

test('conditional recrawl preserves validators and records 304 without new content', () => {
  const store = new FrontierStore();
  store.enqueue('https://example.com/a');
  const first = store.leaseNext({ nowMs: 0 });
  fetched(store, first, { nowMs: 1 });
  assert.equal(store.forceRecrawl(first.url, 20), true);
  const second = store.leaseNext({ nowMs: 20 });
  assert.equal(second.etag, '"v1"');
  store.completeNotModified(second.leaseToken, {
    nowMs: 21,
    cooldownMs: 10,
    finalUrl: second.url,
    etag: '"v1"',
    lastModified: second.lastModified,
    recrawlAtMs: 1_021,
  });
  assert.equal(store.stats().contents, 1);
  assert.equal(store.receipts().at(-1).outcome, 'not_modified');
  store.close();
});

test('retry delay blocks the whole origin rather than only one URL', () => {
  const store = new FrontierStore();
  store.enqueue('https://example.com/a');
  store.enqueue('https://example.com/b');
  const first = store.leaseNext({ nowMs: 0 });
  store.retry(first.leaseToken, {
    nowMs: 1,
    cooldownMs: 100,
    delayMs: 100,
    maxAttempts: 3,
    status: 429,
    errorCode: 'http_429',
  });
  assert.equal(store.leaseNext({ nowMs: 100 }), null);
  assert.ok(store.leaseNext({ nowMs: 101 }));
  store.close();
});
