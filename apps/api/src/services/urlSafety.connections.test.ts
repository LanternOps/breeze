/**
 * Every safeFetch request must dial through its own pinned lookup and address
 * policy. A pooled keep-alive socket keyed only by host:port would let a later
 * request ride a connection that was opened (and approved) for an earlier
 * request under a different policy, to an address the later request never
 * checked.
 *
 * The policy sees test records (10.0.0.5 / 8.8.4.4); only the final TCP dial is
 * redirected to a local server, and every dial is recorded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo, LookupFunction } from 'net';
import { safeFetch, safeFetchFollowingRedirects, __setLookupForTests } from './urlSafety';

const realRequest = http.request;

/** Records the address each request's own lookup pinned, then dials loopback. */
function recordDials(): string[] {
  const dialed: string[] = [];
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
    const pinned = options.lookup!;
    const toLoopback: LookupFunction = (host, opts, done) => {
      const callback = (typeof opts === 'function' ? opts : done) as (...a: unknown[]) => void;
      pinned(host, { all: true }, (err, addrs) => {
        if (err) return callback(err);
        dialed.push((addrs as Array<{ address: string }>)[0]!.address);
        if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
          return;
        }
        callback(null, '127.0.0.1', 4);
      });
    };
    return realRequest({ ...options, lookup: toLoopback }, cb);
  }) as never);
  return dialed;
}

async function keepAliveServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.end('ok')
): Promise<{ port: number; connections: () => number; requests: () => number; close: () => Promise<void> }> {
  let connections = 0;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    handler(req, res);
  });
  server.keepAliveTimeout = 30_000;
  server.on('connection', () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

describe('safeFetch — every request dials through its own pinned lookup', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    __setLookupForTests(null);
    vi.restoreAllMocks();
    await close?.();
    close = undefined;
  });

  it('does not reuse a connection opened under a different address policy', async () => {
    const srv = await keepAliveServer();
    close = srv.close;
    const dialed = recordDials();
    const url = `http://pool.test:${srv.port}/x`;

    // Request 1: private-network opt-in, host resolves to an RFC1918 address.
    __setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);
    const first = await safeFetch(url, { allowPrivateNetwork: true });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('ok');

    // Request 2: strict policy, host now resolves to a public address. It must
    // open its own connection to the address IT approved.
    __setLookupForTests(async () => [{ address: '8.8.4.4', family: 4 }]);
    const second = await safeFetch(url);
    expect(second.status).toBe(200);
    await second.text();

    expect(dialed).toEqual(['10.0.0.5', '8.8.4.4']);
    expect(srv.connections()).toBe(2);
    expect(srv.requests()).toBe(2);
  });

  it('a strict request refused by policy never reaches the server over an earlier connection', async () => {
    const srv = await keepAliveServer();
    close = srv.close;
    recordDials();
    const url = `http://pool.test:${srv.port}/x`;

    __setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);
    await (await safeFetch(url, { allowPrivateNetwork: true })).text();

    await expect(safeFetch(url)).rejects.toThrow(/resolved IPs for pool.test are private/);
    expect(srv.requests()).toBe(1);
  });

  it('each redirect hop dials through its own pinned lookup', async () => {
    const srv = await keepAliveServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' });
        res.end();
        return;
      }
      res.end('done');
    });
    close = srv.close;
    const dialed = recordDials();

    __setLookupForTests(async () => [{ address: '8.8.4.4', family: 4 }]);
    const res = await safeFetchFollowingRedirects(`http://pool.test:${srv.port}/start`);
    expect(await res.text()).toBe('done');

    expect(dialed).toEqual(['8.8.4.4', '8.8.4.4']);
    expect(srv.connections()).toBe(2);
  });
});
