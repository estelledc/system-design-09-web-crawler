import assert from 'node:assert/strict';
import test from 'node:test';
import { EgressPolicy, classifyAddress, canonicalizeUrl } from '../src/index.js';

test('canonical URL identity strips fragments but preserves query order and path semantics', () => {
  assert.equal(
    canonicalizeUrl('HTTPS://Example.COM:443/a/../b?z=2&a=1#section'),
    'https://example.com/b?z=2&a=1',
  );
  assert.equal(canonicalizeUrl('../next#x', 'https://example.com/a/page'), 'https://example.com/next');
});

test('URL policy rejects non-HTTP schemes, embedded credentials, controls, and oversized input', () => {
  for (const value of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
    'https://example.com/\nnext',
    `https://example.com/${'界'.repeat(1400)}`,
  ]) {
    assert.throws(() => canonicalizeUrl(value), { name: 'UrlPolicyError' });
  }
});

test('IP classification separates public unicast from local and reserved ranges', () => {
  assert.equal(classifyAddress('8.8.8.8').range, 'unicast');
  assert.equal(classifyAddress('2606:4700:4700::1111').range, 'unicast');
  assert.equal(classifyAddress('127.0.0.1').range, 'loopback');
  assert.equal(classifyAddress('10.0.0.1').range, 'private');
  assert.equal(classifyAddress('169.254.169.254').range, 'linkLocal');
  assert.equal(classifyAddress('::1').range, 'loopback');
});

test('egress resolution fails closed if any answer is not public unicast', async () => {
  const policy = new EgressPolicy({
    resolver: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
  });
  await assert.rejects(policy.resolve('https://example.com/'), /not public unicast/);
});

test('an exact test-origin exception is scoped to that origin', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  const policy = new EgressPolicy({ resolver, allowedOrigins: ['http://fixture.test:8080'] });
  assert.equal((await policy.resolve('http://fixture.test:8080/a')).address, '127.0.0.1');
  await assert.rejects(policy.resolve('http://fixture.test:8081/a'), /not public unicast/);
});
