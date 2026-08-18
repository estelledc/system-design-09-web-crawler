import { UrlPolicyError } from './errors.js';

export const MAX_URL_BYTES = 4096;

export function canonicalizeUrl(value, base) {
  if (typeof value !== 'string' || value.length === 0) throw new UrlPolicyError('URL must be non-empty');
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new UrlPolicyError('URL contains a control character');
  if (Buffer.byteLength(value, 'utf8') > MAX_URL_BYTES) throw new UrlPolicyError('URL exceeds the byte limit');

  let url;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw new UrlPolicyError('URL cannot be parsed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlPolicyError('only HTTP and HTTPS URLs can be crawled');
  }
  if (!url.hostname) throw new UrlPolicyError('URL must contain a hostname');
  if (url.username || url.password) throw new UrlPolicyError('URL cannot contain embedded credentials');
  url.hash = '';
  const serialized = url.href;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_URL_BYTES) {
    throw new UrlPolicyError('canonical URL exceeds the byte limit');
  }
  return serialized;
}

export function originOf(url) {
  return new URL(canonicalizeUrl(url)).origin;
}
