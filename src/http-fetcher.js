import http from 'node:http';
import https from 'node:https';
import {
  BodyLimitError,
  FetchTimeoutError,
  RedirectPolicyError,
} from './errors.js';
import { canonicalizeUrl } from './url-policy.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class HttpFetcher {
  constructor({
    egressPolicy,
    userAgent = 'EvidenceCrawler/0.1',
    timeoutMs = 5_000,
    maxRedirects = 5,
    redirectDelayMs = 100,
    sleep = defaultSleep,
  }) {
    if (!egressPolicy) throw new TypeError('egressPolicy is required');
    this.egressPolicy = egressPolicy;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.maxRedirects = maxRedirects;
    this.redirectDelayMs = redirectDelayMs;
    this.sleep = sleep;
  }

  async fetch(urlValue, {
    headers = {},
    maxBytes = 2 * 1024 * 1024,
    crossOriginRedirect = 'reject',
  } = {}) {
    if (!['reject', 'return', 'follow'].includes(crossOriginRedirect)) {
      throw new TypeError('crossOriginRedirect must be reject, return, or follow');
    }
    let current = canonicalizeUrl(urlValue);
    const chain = [];
    let currentHeaders = { ...headers };

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      if (chain.includes(current)) throw new RedirectPolicyError('redirect loop detected');
      chain.push(current);
      const response = await this.#requestOnce(current, currentHeaders, maxBytes);
      const location = response.headers.location;
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return { ...response, finalUrl: current, redirectChain: chain };
      }
      if (hop === this.maxRedirects) throw new RedirectPolicyError('redirect limit exceeded');
      const next = canonicalizeUrl(Array.isArray(location) ? location[0] : location, current);
      const crossesOrigin = new URL(next).origin !== new URL(current).origin;
      if (crossesOrigin && crossOriginRedirect === 'reject') {
        throw new RedirectPolicyError('cross-origin redirect requires a new frontier lease');
      }
      if (crossesOrigin && crossOriginRedirect === 'return') {
        return {
          ...response,
          finalUrl: current,
          redirectChain: chain,
          redirectTarget: next,
        };
      }
      if (crossesOrigin) {
        const { 'if-none-match': _etag, 'if-modified-since': _modified, ...safe } = currentHeaders;
        currentHeaders = safe;
      }
      await this.sleep(this.redirectDelayMs);
      current = next;
    }
    throw new RedirectPolicyError('redirect limit exceeded');
  }

  async #requestOnce(urlValue, headers, maxBytes) {
    const url = new URL(urlValue);
    const approved = await this.egressPolicy.resolve(url.href);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method: 'GET',
        family: approved.family,
        autoSelectFamily: false,
        headers: {
          accept: 'text/html, text/plain;q=0.2',
          'accept-encoding': 'identity',
          'user-agent': this.userAgent,
          ...headers,
        },
        lookup: (_hostname, _options, callback) => callback(null, approved.address, approved.family),
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new BodyLimitError(maxBytes));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
        response.on('error', reject);
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new FetchTimeoutError()));
      request.on('error', reject);
      request.end();
    });
  }
}

export function parseRetryAfter(value, nowMs, { maxDelayMs = 60 * 60 * 1000 } = {}) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string') return null;
  let delayMs;
  if (/^[0-9]+$/.test(value.trim())) delayMs = Number(value.trim()) * 1000;
  else {
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) return null;
    delayMs = Math.max(0, instant - nowMs);
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) return null;
  return Math.min(delayMs, maxDelayMs);
}
