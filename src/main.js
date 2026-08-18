import { resolve } from 'node:path';
import { CrawlWorker } from './crawler.js';
import { EgressPolicy } from './egress-policy.js';
import { FrontierStore } from './frontier-store.js';
import { HttpFetcher } from './http-fetcher.js';
import { RobotsPolicy } from './robots-policy.js';

const [command = 'stats', ...args] = process.argv.slice(2);
const statePath = resolve(process.env.CRAWLER_STATE_PATH ?? '.tmp/crawler.sqlite');
let allowedOrigins = [];
if (process.env.CRAWLER_ALLOWED_TEST_ORIGINS) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-origin egress bypass requires NODE_ENV=test');
  allowedOrigins = JSON.parse(process.env.CRAWLER_ALLOWED_TEST_ORIGINS);
  if (!Array.isArray(allowedOrigins)) throw new Error('CRAWLER_ALLOWED_TEST_ORIGINS must be a JSON array');
}

const store = new FrontierStore(statePath);
try {
  if (command === 'seed') {
    if (args.length === 0) throw new Error('seed requires at least one URL');
    store.enqueueMany(args);
    process.stdout.write(`${JSON.stringify({ kind: 'seed_receipt', accepted: args.length })}\n`);
  } else if (command === 'run') {
    const maxJobsArg = args.find((arg) => arg.startsWith('--max-jobs='));
    const maxJobs = Number(maxJobsArg?.split('=')[1] ?? 100);
    if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) throw new Error('max jobs is invalid');
    const egressPolicy = new EgressPolicy({ allowedOrigins });
    const fetcher = new HttpFetcher({ egressPolicy });
    const robotsPolicy = new RobotsPolicy({ store, fetcher });
    const worker = new CrawlWorker({
      store,
      fetcher,
      robotsPolicy,
      logger: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
    });
    const result = await worker.run({ maxJobs });
    process.stdout.write(`${JSON.stringify({ kind: 'crawl_run_receipt', ...result })}\n`);
  } else if (command === 'stats') {
    process.stdout.write(`${JSON.stringify({ kind: 'crawler_stats', ...store.stats() })}\n`);
  } else {
    throw new Error('command must be seed, run, or stats');
  }
} finally {
  store.close();
}
