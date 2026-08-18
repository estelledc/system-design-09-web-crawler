import { parse } from 'parse5';
import { canonicalizeUrl } from './url-policy.js';

function attribute(node, name) {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}

export function extractHtmlLinks(html, documentUrl, { maxLinks = 200 } = {}) {
  if (typeof html !== 'string') throw new TypeError('html must be a string');
  if (!Number.isInteger(maxLinks) || maxLinks < 0 || maxLinks > 10_000) {
    throw new RangeError('maxLinks must be from 0 through 10000');
  }
  const document = parse(html);
  const stack = [document];
  const linkValues = [];
  let baseUrl = documentUrl;
  let baseChosen = false;
  let nofollow = false;

  while (stack.length > 0) {
    const node = stack.pop();
    if (node.tagName === 'base' && !baseChosen) {
      const href = attribute(node, 'href');
      if (href) {
        try {
          baseUrl = canonicalizeUrl(href, documentUrl);
          baseChosen = true;
        } catch {}
      }
    }
    if (node.tagName === 'meta' && attribute(node, 'name')?.toLowerCase() === 'robots') {
      const directives = (attribute(node, 'content') ?? '').toLowerCase().split(/[\s,]+/u);
      if (directives.includes('nofollow') || directives.includes('none')) nofollow = true;
    }
    if (node.tagName === 'a' || node.tagName === 'area') {
      const href = attribute(node, 'href');
      if (href) linkValues.push(href);
    }
    if (node.childNodes) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]);
      }
    }
  }

  if (nofollow) return { links: [], nofollow: true, baseUrl };
  const links = [];
  const seen = new Set();
  for (const href of linkValues) {
    if (links.length >= maxLinks) break;
    try {
      const canonical = canonicalizeUrl(href, baseUrl);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        links.push(canonical);
      }
    } catch {}
  }
  return { links, nofollow: false, baseUrl };
}
