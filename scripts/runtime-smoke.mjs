import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CrawlWorker,
  EgressPolicy,
  FrontierStore,
  HttpFetcher,
  RobotsPolicy,
} from '../src/index.js';

const directory = mkdtempSync(join(tmpdir(), 'crawler-smoke-'));
const statePath = join(directory, 'frontier.sqlite');
const requestReceipts = [];
const sharedBody = '<html><body><p>same content</p></body></html>';
const server = http.createServer((request, response) => {
  requestReceipts.push({ path: request.url, at: performance.now(), conditional: request.headers['if-none-match'] ?? null });
  if (request.url === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain', etag: '"robots-v1"' });
    return response.end('User-agent: EvidenceCrawler\nDisallow: /private');
  }
  if (request.url === '/index') {
    response.writeHead(200, { 'content-type': 'text/html', etag: '"index-v1"' });
    return response.end('<a href="/page">page</a><a href="/copy">copy</a><a href="/private">private</a>');
  }
  if (request.url === '/page' && request.headers['if-none-match'] === '"page-v1"') {
    response.writeHead(304, { etag: '"page-v1"' });
    return response.end();
  }
  if (request.url === '/page' || request.url === '/copy') {
    response.writeHead(200, { 'content-type': 'text/html', etag: '"page-v1"' });
    return response.end(sharedBody);
  }
  response.writeHead(500);
  return response.end('unexpected path');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const seedUrl = `${origin}/index`;

let store = new FrontierStore(statePath);
store.enqueue(seedUrl, { availableAtMs: Date.now() });
store.close();

const crash = spawn(process.execPath, ['scripts/lease-and-crash.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, CRAWLER_STATE_PATH: statePath, LEASE_MS: '100' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let crashOutput = '';
crash.stdout.on('data', (chunk) => { crashOutput += chunk; });
crash.stderr.on('data', (chunk) => { crashOutput += chunk; });
const [crashCode, crashSignal] = await once(crash, 'exit');
assert.equal(crashCode, null);
assert.equal(crashSignal, 'SIGKILL');

store = new FrontierStore(statePath);
assert.equal(store.stats().frontier.leased, 1);
store.close();
await new Promise((resolve) => setTimeout(resolve, 140));

store = new FrontierStore(statePath);
const logs = [];
const cooldownMs = 25;
const fetcher = new HttpFetcher({
  egressPolicy: new EgressPolicy({ allowedOrigins: [origin] }),
  redirectDelayMs: cooldownMs,
});
const robotsPolicy = new RobotsPolicy({ store, fetcher });
const worker = new CrawlWorker({
  store,
  fetcher,
  robotsPolicy,
  cooldownMs,
  crashCooldownMs: 20,
  leaseMs: 5_000,
  baseRetryMs: 20,
  logger: (record) => logs.push(record),
});

const run = await worker.run({ maxJobs: 4 });
assert.equal(run.processed, 4);
assert.equal(store.get(seedUrl).attempts, 2);
assert.equal(store.stats().contents, 2);
assert.equal(store.stats().frontier.done, 4);
assert.equal(requestReceipts.some((receipt) => receipt.path === '/private'), false);

assert.equal(store.forceRecrawl(`${origin}/page`, Date.now()), true);
const recrawl = await worker.run({ maxJobs: 1 });
assert.equal(recrawl.processed, 1);
assert.equal(store.receipts().at(-1).outcome, 'not_modified');
assert.equal(requestReceipts.findLast((receipt) => receipt.path === '/page').conditional, '"page-v1"');

const gaps = requestReceipts.slice(1).map((receipt, index) => receipt.at - requestReceipts[index].at);
const minimumGapMs = Math.min(...gaps);
assert.ok(minimumGapMs >= 15, `same-origin request gap was only ${minimumGapMs}ms`);

const logText = `${crashOutput}${JSON.stringify(logs)}`;
for (const identity of [origin, '/index', '/page', '/copy', '/private', 'lease_token', 'content_digest']) {
  assert.ok(!logText.includes(identity), 'runtime logs contained crawl identity');
}
store.close();

const reopened = new FrontierStore(statePath);
const finalStats = reopened.stats();
assert.equal(finalStats.contents, 2);
assert.equal(finalStats.receipts, 5);
reopened.close();

server.close();
await once(server, 'close');
rmSync(directory, { recursive: true, force: true });

process.stdout.write(`${JSON.stringify({
  kind: 'crawler_crash_politeness_receipt',
  node: process.version,
  sqlite: 'node:sqlite',
  forcedTermination: 'SIGKILL',
  expiredLeaseRecovered: true,
  recoveredSeedAttempts: 2,
  sameOriginMinimumObservedGapMs: Number(minimumGapMs.toFixed(3)),
  robotsBlockedRequestCount: 0,
  canonicalUrlsDone: 4,
  uniqueContentObjects: 2,
  fetchReceipts: 5,
  conditionalRecrawlStatus: 304,
  rawCrawlIdentityLogged: false,
  claimBoundary: 'single host, one worker after crash, loopback HTTP fixture, SQLite WAL, and process SIGKILL; not power loss, distributed leasing, public-web compliance, or production throughput',
})}\n`);
