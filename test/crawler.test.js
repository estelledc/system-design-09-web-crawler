import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import {
  CrawlWorker,
  EgressPolicy,
  FrontierStore,
  HttpFetcher,
  RobotsPolicy,
} from '../src/index.js';

async function fixture() {
  const seen = [];
  const shared = '<html><body><p>shared</p></body></html>';
  const server = http.createServer((request, response) => {
    seen.push({ path: request.url, headers: request.headers });
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain', etag: '"robots-1"' });
      return response.end('User-agent: EvidenceCrawler\nDisallow: /private');
    }
    if (request.url === '/index') {
      response.writeHead(200, { 'content-type': 'text/html', etag: '"index-1"' });
      return response.end('<a href="/page">page</a><a href="/copy">copy</a><a href="/private">private</a>');
    }
    if (request.url === '/page' && request.headers['if-none-match'] === '"page-1"') {
      response.writeHead(304, { etag: '"page-1"' });
      return response.end();
    }
    if (request.url === '/page' || request.url === '/copy') {
      response.writeHead(200, { 'content-type': 'text/html', etag: '"page-1"' });
      return response.end(shared);
    }
    response.writeHead(404);
    return response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    seen,
  };
}

test('crawler obeys robots, deduplicates bytes, and performs a conditional recrawl', async () => {
  const { server, origin, seen } = await fixture();
  let nowMs = 1_000;
  const delays = [];
  const sleep = async (delay) => { delays.push(delay); nowMs += delay; };
  const store = new FrontierStore();
  const fetcher = new HttpFetcher({
    egressPolicy: new EgressPolicy({ allowedOrigins: [origin] }),
    redirectDelayMs: 10,
    sleep,
  });
  const robotsPolicy = new RobotsPolicy({ store, fetcher, clock: () => nowMs });
  const worker = new CrawlWorker({
    store,
    fetcher,
    robotsPolicy,
    clock: () => nowMs,
    sleep,
    cooldownMs: 10,
    crashCooldownMs: 10,
    baseRetryMs: 10,
  });
  store.enqueue(`${origin}/index`, { availableAtMs: nowMs });
  try {
    const run = await worker.run({ maxJobs: 4 });
    assert.equal(run.processed, 4);
    assert.equal(store.stats().frontier.done, 4);
    assert.equal(store.stats().contents, 2);
    assert.equal(seen.some((entry) => entry.path === '/private'), false);
    assert.ok(delays.includes(10), 'robots-to-page cooldown was not applied');

    assert.equal(store.forceRecrawl(`${origin}/page`, nowMs), true);
    const recrawl = await worker.run({ maxJobs: 1 });
    assert.equal(recrawl.processed, 1);
    assert.equal(store.receipts().at(-1).outcome, 'not_modified');
    const conditional = seen.findLast((entry) => entry.path === '/page');
    assert.equal(conditional.headers['if-none-match'], '"page-1"');
  } finally {
    store.close();
    server.close();
    await once(server, 'close');
  }
});

test('robots unreachable is retried and then moves to dead after the bounded attempt budget', async () => {
  let nowMs = 0;
  const store = new FrontierStore();
  store.enqueue('https://example.com/a');
  const robotsPolicy = {
    allowed: async () => ({ allowed: false, retryable: true, networkRequest: true, source: 'unreachable' }),
  };
  const worker = new CrawlWorker({
    store,
    fetcher: { fetch: async () => { throw new Error('page fetch must not run'); } },
    robotsPolicy,
    clock: () => nowMs,
    sleep: async (delay) => { nowMs += delay; },
    cooldownMs: 0,
    crashCooldownMs: 0,
    baseRetryMs: 1,
    maxAttempts: 2,
  });
  const first = await worker.runOne();
  assert.equal(first.outcome, 'retry_scheduled');
  nowMs += 1;
  const second = await worker.runOne();
  assert.equal(second.outcome, 'retry_exhausted');
  assert.equal(store.stats().frontier.dead, 1);
  store.close();
});
