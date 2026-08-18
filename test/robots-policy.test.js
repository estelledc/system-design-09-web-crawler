import assert from 'node:assert/strict';
import test from 'node:test';
import { FrontierStore, RobotsPolicy } from '../src/index.js';

function response(status, body = '', headers = {}) {
  return { status, body: Buffer.from(body), headers, finalUrl: 'https://example.com/robots.txt' };
}

test('RFC-style longest match allows a more specific path and cache avoids a second request', async () => {
  const store = new FrontierStore();
  let calls = 0;
  const fetcher = {
    fetch: async () => {
      calls += 1;
      return response(200, [
        'User-agent: EvidenceCrawler',
        'Disallow: /fish',
        'Allow: /fishheads',
      ].join('\n'), { etag: '"robots-v1"' });
    },
  };
  const policy = new RobotsPolicy({ store, fetcher, clock: () => 1_000 });
  assert.equal((await policy.allowed('https://example.com/fishheads/yummy')).allowed, true);
  assert.equal((await policy.allowed('https://example.com/fish/salmon')).allowed, false);
  assert.equal(calls, 1);
  store.close();
});

test('4xx robots is unavailable/allow-all while 5xx without cache fails closed and retries', async () => {
  const allowStore = new FrontierStore();
  const allow = new RobotsPolicy({
    store: allowStore,
    fetcher: { fetch: async () => response(404) },
    clock: () => 1_000,
  });
  assert.deepEqual(
    await allow.allowed('https://example.com/a'),
    { allowed: true, networkRequest: true, retryable: false, source: 'unavailable_allow_all' },
  );
  allowStore.close();

  const denyStore = new FrontierStore();
  const deny = new RobotsPolicy({
    store: denyStore,
    fetcher: { fetch: async () => response(503) },
    clock: () => 1_000,
  });
  const decision = await deny.allowed('https://example.com/a');
  assert.equal(decision.allowed, false);
  assert.equal(decision.retryable, true);
  assert.equal(decision.source, 'complete_disallow_after_unreachable');
  denyStore.close();
});

test('an unreachable refresh may continue using a stale cached rule', async () => {
  const store = new FrontierStore();
  store.saveRobots({
    origin: 'https://example.com',
    policyState: 'rules',
    body: 'User-agent: *\nDisallow: /private',
    fetchedAtMs: 0,
    expiresAtMs: 1,
    status: 200,
  });
  const policy = new RobotsPolicy({
    store,
    fetcher: { fetch: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } },
    clock: () => 2,
  });
  const decision = await policy.allowed('https://example.com/public');
  assert.equal(decision.allowed, true);
  assert.equal(decision.retryable, false);
  assert.equal(decision.source, 'stale_cache_after_unreachable');
  store.close();
});

test('robots 429 is treated as temporary complete disallow, not allow-all', async () => {
  const store = new FrontierStore();
  const policy = new RobotsPolicy({
    store,
    fetcher: { fetch: async () => response(429) },
    clock: () => 1_000,
  });
  const decision = await policy.allowed('https://example.com/a');
  assert.equal(decision.allowed, false);
  assert.equal(decision.retryable, true);
  assert.equal(decision.source, 'complete_disallow_after_unreachable');
  store.close();
});
