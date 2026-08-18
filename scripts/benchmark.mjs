import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrontierStore } from '../src/index.js';

const enqueueCount = Number(process.env.BENCHMARK_ENQUEUE_COUNT ?? 10_000);
const lifecycleCount = Number(process.env.BENCHMARK_LIFECYCLE_COUNT ?? 2_000);
assert.ok(Number.isInteger(enqueueCount) && enqueueCount >= lifecycleCount && enqueueCount <= 100_000);
assert.ok(Number.isInteger(lifecycleCount) && lifecycleCount >= 500 && lifecycleCount <= 20_000);

const directory = mkdtempSync(join(tmpdir(), 'crawler-benchmark-'));
const statePath = join(directory, 'frontier.sqlite');
const store = new FrontierStore(statePath);
const urls = Array.from({ length: enqueueCount }, (_, index) => `https://example.com/page/${String(index).padStart(8, '0')}`);

const enqueueStart = performance.now();
store.enqueueMany(urls);
const enqueueElapsedMs = performance.now() - enqueueStart;

const lifecycleStart = performance.now();
for (let index = 0; index < lifecycleCount; index += 1) {
  const lease = store.leaseNext({ nowMs: 0, leaseMs: 1_000, crashCooldownMs: 0 });
  assert.ok(lease);
  store.completeTerminal(lease.leaseToken, {
    nowMs: 0,
    cooldownMs: 0,
    status: 204,
    finalUrl: lease.url,
    outcome: 'benchmark_complete',
  });
}
const lifecycleElapsedMs = performance.now() - lifecycleStart;
const lifecycleOperationsPerSecond = Math.round((lifecycleCount * 1000) / lifecycleElapsedMs);
const floor = 100;
assert.ok(lifecycleOperationsPerSecond >= floor, `durable frontier lifecycle fell below ${floor} operations/s`);
const stats = store.stats();
store.close();
rmSync(directory, { recursive: true, force: true });

process.stdout.write(`${JSON.stringify({
  kind: 'single_host_sqlite_frontier_benchmark',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  enqueueCount,
  enqueueElapsedMs: Number(enqueueElapsedMs.toFixed(3)),
  lifecycleCount,
  lifecycleElapsedMs: Number(lifecycleElapsedMs.toFixed(3)),
  lifecycleOperationsPerSecond,
  requirementFloorOperationsPerSecond: floor,
  finalDone: stats.frontier.done,
  finalQueued: stats.frontier.queued,
  claimBoundary: 'single-process SQLite WAL with FULL synchronous mode and one origin; excludes DNS, HTTP, parsing, robots, multiple workers, internet latency, and production capacity',
})}\n`);
