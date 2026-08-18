import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { EgressPolicy, HttpFetcher, parseRetryAfter } from '../src/index.js';

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('approved DNS answer is pinned into the socket and same-origin redirects are delayed', async () => {
  const requests = [];
  const server = await listen((request, response) => {
    requests.push({ path: request.url, host: request.headers.host });
    if (request.url === '/start') {
      response.writeHead(302, { location: '/final' });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<p>ok</p>');
    }
  });
  const port = server.address().port;
  const origin = `http://fixture.test:${port}`;
  const delays = [];
  const policy = new EgressPolicy({
    resolver: async () => [{ address: '127.0.0.1', family: 4 }],
    allowedOrigins: [origin],
  });
  const fetcher = new HttpFetcher({
    egressPolicy: policy,
    redirectDelayMs: 17,
    sleep: async (delay) => { delays.push(delay); },
  });
  try {
    const result = await fetcher.fetch(`${origin}/start`);
    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, `${origin}/final`);
    assert.deepEqual(delays, [17]);
    assert.deepEqual(requests.map((item) => item.path), ['/start', '/final']);
    assert.ok(requests.every((item) => item.host === `fixture.test:${port}`));
  } finally {
    await close(server);
  }
});

test('cross-origin redirect is returned for a new frontier lease instead of followed', async () => {
  const destination = await listen((_request, response) => response.end('should not be reached'));
  const source = await listen((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/target` });
    response.end();
  });
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  const destinationOrigin = `http://127.0.0.1:${destination.address().port}`;
  const fetcher = new HttpFetcher({
    egressPolicy: new EgressPolicy({ allowedOrigins: [sourceOrigin, destinationOrigin] }),
  });
  try {
    const result = await fetcher.fetch(`${sourceOrigin}/start`, { crossOriginRedirect: 'return' });
    assert.equal(result.status, 302);
    assert.equal(result.redirectTarget, `${destinationOrigin}/target`);
  } finally {
    await close(source);
    await close(destination);
  }
});

test('body limit aborts the response and Retry-After is bounded', async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('x'.repeat(100));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetcher = new HttpFetcher({ egressPolicy: new EgressPolicy({ allowedOrigins: [origin] }) });
  try {
    await assert.rejects(fetcher.fetch(`${origin}/`, { maxBytes: 50 }), { name: 'BodyLimitError' });
  } finally {
    await close(server);
  }
  assert.equal(parseRetryAfter('12', 0), 12_000);
  assert.equal(parseRetryAfter('999999', 0), 3_600_000);
  assert.equal(parseRetryAfter('not-a-date', 0), null);
});
