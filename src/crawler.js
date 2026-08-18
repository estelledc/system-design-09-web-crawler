import { createHash } from 'node:crypto';
import { extractHtmlLinks } from './html-extractor.js';
import { parseRetryAfter } from './http-fetcher.js';

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function contentType(headers) {
  const value = Array.isArray(headers['content-type']) ? headers['content-type'][0] : headers['content-type'];
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function header(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value ?? null;
}

export class CrawlWorker {
  constructor({
    store,
    fetcher,
    robotsPolicy,
    clock = () => Date.now(),
    sleep = defaultSleep,
    logger = () => {},
    cooldownMs = 100,
    leaseMs = 30_000,
    crashCooldownMs = 1_000,
    maxAttempts = 3,
    maxDepth = 2,
    maxLinksPerPage = 200,
    maxPageBytes = 2 * 1024 * 1024,
    baseRetryMs = 1_000,
    recrawlMs = 24 * 60 * 60 * 1000,
  }) {
    this.store = store;
    this.fetcher = fetcher;
    this.robotsPolicy = robotsPolicy;
    this.clock = clock;
    this.sleep = sleep;
    this.logger = logger;
    this.cooldownMs = cooldownMs;
    this.leaseMs = leaseMs;
    this.crashCooldownMs = crashCooldownMs;
    this.maxAttempts = maxAttempts;
    this.maxDepth = maxDepth;
    this.maxLinksPerPage = maxLinksPerPage;
    this.maxPageBytes = maxPageBytes;
    this.baseRetryMs = baseRetryMs;
    this.recrawlMs = recrawlMs;
  }

  async runOne() {
    const lease = this.store.leaseNext({
      nowMs: this.clock(),
      leaseMs: this.leaseMs,
      crashCooldownMs: this.crashCooldownMs,
    });
    if (!lease) return { outcome: 'idle' };

    let status = null;
    try {
      const robots = await this.robotsPolicy.allowed(lease.url);
      if (!robots.allowed) {
        if (robots.retryable) {
          return this.#retry(lease, {
            errorCode: 'robots_unreachable',
            delayMs: this.baseRetryMs,
            originDelayMs: this.baseRetryMs,
          });
        }
        const result = this.store.completeTerminal(lease.leaseToken, {
          nowMs: this.clock(),
          cooldownMs: this.cooldownMs,
          outcome: 'robots_disallowed',
          errorCode: null,
        });
        this.#log(result.outcome, status, lease);
        return result;
      }
      if (robots.networkRequest) await this.sleep(this.cooldownMs);

      const headers = {};
      if (lease.etag) headers['if-none-match'] = lease.etag;
      if (lease.lastModified) headers['if-modified-since'] = lease.lastModified;
      const response = await this.fetcher.fetch(lease.url, {
        headers,
        maxBytes: this.maxPageBytes,
        crossOriginRedirect: 'return',
      });
      status = response.status;
      const nowMs = this.clock();

      if (response.redirectTarget) {
        this.store.enqueue(response.redirectTarget, {
          depth: lease.depth,
          priority: lease.priority,
          discoveredFrom: lease.url,
          availableAtMs: nowMs,
        });
        const result = this.store.completeTerminal(lease.leaseToken, {
          nowMs,
          cooldownMs: this.cooldownMs,
          status,
          finalUrl: response.finalUrl,
          outcome: 'cross_origin_redirect_enqueued',
        });
        this.#log(result.outcome, status, lease);
        return result;
      }

      if (status === 304) {
        if (!lease.contentDigest) {
          const result = this.store.completeTerminal(lease.leaseToken, {
            nowMs,
            cooldownMs: this.cooldownMs,
            status,
            finalUrl: response.finalUrl,
            outcome: 'invalid_not_modified_without_content',
            errorCode: 'invalid_304',
          });
          this.#log(result.outcome, status, lease);
          return result;
        }
        const result = this.store.completeNotModified(lease.leaseToken, {
          nowMs,
          cooldownMs: this.cooldownMs,
          finalUrl: response.finalUrl,
          etag: header(response.headers, 'etag'),
          lastModified: header(response.headers, 'last-modified'),
          recrawlAtMs: nowMs + this.recrawlMs,
        });
        this.#log(result.outcome, status, lease);
        return result;
      }

      if (status === 429 || status === 503 || status >= 500) {
        const retryAfter = parseRetryAfter(response.headers['retry-after'], nowMs);
        return this.#retry(lease, {
          status,
          finalUrl: response.finalUrl,
          errorCode: `http_${status}`,
          delayMs: retryAfter ?? this.#backoff(lease.attempts),
          originDelayMs: retryAfter ?? this.#backoff(lease.attempts),
        });
      }

      if (status < 200 || status >= 300) {
        const result = this.store.completeTerminal(lease.leaseToken, {
          nowMs,
          cooldownMs: this.cooldownMs,
          status,
          finalUrl: response.finalUrl,
          outcome: 'terminal_http_status',
          errorCode: `http_${status}`,
        });
        this.#log(result.outcome, status, lease);
        return result;
      }

      const encoding = header(response.headers, 'content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') {
        const result = this.store.completeTerminal(lease.leaseToken, {
          nowMs,
          cooldownMs: this.cooldownMs,
          status,
          finalUrl: response.finalUrl,
          outcome: 'unsupported_content_encoding',
          errorCode: 'encoded_body_rejected',
        });
        this.#log(result.outcome, status, lease);
        return result;
      }

      const type = contentType(response.headers);
      if (type !== 'text/html') {
        const result = this.store.completeTerminal(lease.leaseToken, {
          nowMs,
          cooldownMs: this.cooldownMs,
          status,
          finalUrl: response.finalUrl,
          outcome: 'unsupported_content_type',
          errorCode: type ? 'not_html' : 'missing_content_type',
        });
        this.#log(result.outcome, status, lease);
        return result;
      }

      const digest = createHash('sha256').update(response.body).digest('hex');
      const extracted = extractHtmlLinks(response.body.toString('utf8'), response.finalUrl, {
        maxLinks: this.maxLinksPerPage,
      });
      const result = this.store.completeFetched(lease.leaseToken, {
        nowMs,
        cooldownMs: this.cooldownMs,
        status,
        finalUrl: response.finalUrl,
        contentType: type,
        body: response.body,
        digest,
        etag: header(response.headers, 'etag'),
        lastModified: header(response.headers, 'last-modified'),
        links: extracted.links,
        maxDepth: this.maxDepth,
        recrawlAtMs: nowMs + this.recrawlMs,
      });
      this.#log(result.outcome, status, lease);
      return result;
    } catch (error) {
      const retryable = error.retryable === true || RETRYABLE_CODES.has(error.code);
      if (retryable) {
        const delayMs = this.#backoff(lease.attempts);
        return this.#retry(lease, {
          status,
          errorCode: error.code ?? 'network_error',
          delayMs,
          originDelayMs: delayMs,
        });
      }
      const result = this.store.completeTerminal(lease.leaseToken, {
        nowMs: this.clock(),
        cooldownMs: this.cooldownMs,
        status,
        outcome: 'policy_or_parse_rejected',
        errorCode: error.code ?? 'unexpected_error',
      });
      this.#log(result.outcome, status, lease);
      return result;
    }
  }

  async run({ maxJobs = 100, maxIdlePolls = 100 } = {}) {
    let processed = 0;
    let idlePolls = 0;
    while (processed < maxJobs && idlePolls < maxIdlePolls) {
      const result = await this.runOne();
      if (result.outcome !== 'idle') {
        processed += 1;
        idlePolls = 0;
        continue;
      }
      idlePolls += 1;
      const next = this.store.nextReadyAtMs();
      if (next === null) break;
      await this.sleep(Math.max(1, Math.min(100, next - this.clock())));
    }
    return { processed, stats: this.store.stats() };
  }

  #retry(lease, {
    status = null,
    finalUrl = null,
    errorCode,
    delayMs,
    originDelayMs = this.cooldownMs,
  }) {
    const result = this.store.retry(lease.leaseToken, {
      nowMs: this.clock(),
      cooldownMs: Math.max(this.cooldownMs, originDelayMs),
      delayMs,
      maxAttempts: this.maxAttempts,
      status,
      finalUrl,
      errorCode,
    });
    this.#log(result.outcome, status, lease);
    return result;
  }

  #backoff(attempts) {
    return Math.min(60 * 60 * 1000, this.baseRetryMs * (2 ** Math.max(0, attempts - 1)));
  }

  #log(outcome, status, lease) {
    this.logger({
      kind: 'crawl_job',
      outcome,
      status,
      depth: lease.depth,
      attempt: lease.attempts,
    });
  }
}
