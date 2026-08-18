import assert from 'node:assert/strict';
import { FrontierStore } from '../src/index.js';

const statePath = process.env.CRAWLER_STATE_PATH;
assert.ok(statePath, 'CRAWLER_STATE_PATH is required');
const leaseMs = Number(process.env.LEASE_MS ?? 100);
const store = new FrontierStore(statePath);
const lease = store.leaseNext({ nowMs: Date.now(), leaseMs, crashCooldownMs: 20 });
assert.ok(lease, 'expected one frontier lease');
process.kill(process.pid, 'SIGKILL');
