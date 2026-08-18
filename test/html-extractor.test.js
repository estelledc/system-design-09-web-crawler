import assert from 'node:assert/strict';
import test from 'node:test';
import { extractHtmlLinks } from '../src/index.js';

test('HTML extraction respects the first valid base, canonicalizes, deduplicates, and bounds links', () => {
  const html = `<!doctype html><html><head>
    <base href="https://cdn.example/base/">
    <base href="https://ignored.example/">
  </head><body>
    <a href="a#one">A</a><a href="a#two">A duplicate</a>
    <area href="../map"><a href="mailto:test@example.com">mail</a>
  </body></html>`;
  const result = extractHtmlLinks(html, 'https://origin.example/root', { maxLinks: 2 });
  assert.deepEqual(result.links, ['https://cdn.example/base/a', 'https://cdn.example/map']);
  assert.equal(result.baseUrl, 'https://cdn.example/base/');
});

test('meta robots nofollow suppresses discovery without changing content parsing', () => {
  const result = extractHtmlLinks(
    '<meta name="robots" content="noindex, nofollow"><a href="https://example.com/a">a</a>',
    'https://origin.example/',
  );
  assert.equal(result.nofollow, true);
  assert.deepEqual(result.links, []);
});
