import robotsParser from 'robots-parser';
import { originOf } from './url-policy.js';

export const ROBOTS_CACHE_MS = 24 * 60 * 60 * 1000;
export const ROBOTS_MAX_BYTES = 500 * 1024;

function conditionalHeaders(cached) {
  const headers = {};
  if (cached?.etag) headers['if-none-match'] = cached.etag;
  if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;
  return headers;
}

function decide(record, url, userAgentToken) {
  if (record.policyState === 'allow_all') return true;
  if (record.policyState === 'disallow_all') return false;
  const policy = robotsParser(`${record.origin}/robots.txt`, record.body ?? '');
  return policy.isAllowed(url, userAgentToken) !== false;
}

export class RobotsPolicy {
  constructor({ store, fetcher, userAgentToken = 'EvidenceCrawler', clock = () => Date.now() }) {
    this.store = store;
    this.fetcher = fetcher;
    this.userAgentToken = userAgentToken;
    this.clock = clock;
  }

  async allowed(url) {
    const nowMs = this.clock();
    const origin = originOf(url);
    const cached = this.store.getRobots(origin);
    if (cached && cached.expiresAtMs > nowMs) {
      return {
        allowed: decide(cached, url, this.userAgentToken), networkRequest: false, retryable: false, source: 'fresh_cache',
      };
    }

    let response;
    try {
      response = await this.fetcher.fetch(`${origin}/robots.txt`, {
        headers: conditionalHeaders(cached),
        maxBytes: ROBOTS_MAX_BYTES,
        crossOriginRedirect: 'follow',
      });
    } catch (error) {
      const fallback = cached ?? {
        origin,
        policyState: 'disallow_all',
        body: '',
      };
      this.store.saveRobots({
        ...fallback,
        fetchedAtMs: nowMs,
        expiresAtMs: nowMs + Math.min(5 * 60 * 1000, ROBOTS_CACHE_MS),
        status: null,
        lastError: error.code ?? 'fetch_error',
      });
      return {
        allowed: decide(fallback, url, this.userAgentToken),
        networkRequest: true,
        retryable: !cached,
        source: cached ? 'stale_cache_after_unreachable' : 'complete_disallow_after_unreachable',
      };
    }

    if (response.status === 304 && cached) {
      const refreshed = {
        ...cached,
        fetchedAtMs: nowMs,
        expiresAtMs: nowMs + ROBOTS_CACHE_MS,
        status: 304,
        etag: response.headers.etag ?? cached.etag,
        lastModified: response.headers['last-modified'] ?? cached.lastModified,
        lastError: null,
      };
      this.store.saveRobots(refreshed);
      return {
        allowed: decide(refreshed, url, this.userAgentToken), networkRequest: true, retryable: false, source: 'validated_cache',
      };
    }

    let policyState;
    let body = '';
    let source;
    if (response.status >= 200 && response.status < 300) {
      policyState = 'rules';
      body = response.body.toString('utf8');
      source = 'fetched_rules';
    } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      policyState = 'allow_all';
      source = 'unavailable_allow_all';
    } else {
      const fallback = cached ?? { origin, policyState: 'disallow_all', body: '' };
      policyState = fallback.policyState;
      body = fallback.body ?? '';
      source = cached ? 'stale_cache_after_unreachable' : 'complete_disallow_after_unreachable';
    }

    const record = {
      origin,
      policyState,
      body,
      fetchedAtMs: nowMs,
      expiresAtMs: nowMs + (response.status >= 500 || response.status === 429 ? 5 * 60 * 1000 : ROBOTS_CACHE_MS),
      status: response.status,
      etag: response.headers.etag ?? null,
      lastModified: response.headers['last-modified'] ?? null,
      lastError: response.status >= 500 || response.status === 429 ? `http_${response.status}` : null,
    };
    this.store.saveRobots(record);
    return {
      allowed: decide(record, url, this.userAgentToken),
      networkRequest: true,
      retryable: (response.status >= 500 || response.status === 429 || response.status === 304) && !cached,
      source,
    };
  }
}
