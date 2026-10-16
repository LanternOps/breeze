/**
 * `safeFetchFollowingRedirects(..., { allowHost })` — a caller-supplied host
 * predicate checked against EVERY hop (the first URL included) before that hop
 * is resolved or dialed. The workload image-currency registry client uses it
 * to keep the whole redirect chain on its registry allowlist; the pinned-DNS
 * policy still applies to every hop as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo, LookupFunction } from 'net';
import { safeFetchFollowingRedirects, SsrfBlockedError, __setLookupForTests } from './urlSafety';

const realRequest = http.request;

/** Dial loopback whatever the pinned record was; record each pinned (host, ip). */
function recordDials(): Array<{ host: string; ip: string }> {
  const dialed: Array<{ host: string; ip: string }> = [];
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
    const pinned = options.lookup!;
    const toLoopback: LookupFunction = (host, opts, done) => {
      const callback = (typeof opts === 'function' ? opts : done) as (...a: unknown[]) => void;
      pinned(host, { all: true }, (err, addrs) => {
        if (err) return callback(err);
        dialed.push({ host, ip: (addrs as Array<{ address: string }>)[0]!.address });
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

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  let requests = 0;
  const srv = http.createServer((req, res) => {
    requests++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    port: (srv.address() as AddressInfo).port,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        srv.closeAllConnections();
        srv.close(() => resolve());
      }),
  };
}

describe('safeFetchFollowingRedirects — allowHost', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    __setLookupForTests(null);
    vi.restoreAllMocks();
    await close?.();
    close = undefined;
  });

  it('refuses the first URL when its host fails the predicate, without resolving or dialing', async () => {
    const lookup = vi.fn(async () => [{ address: '8.8.4.4', family: 4 }]);
    __setLookupForTests(lookup);
    const dialed = recordDials();
    await expect(
      safeFetchFollowingRedirects('http://evil.test:1/x', {}, undefined, { allowHost: (u) => u.hostname === 'good.test' }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(lookup).not.toHaveBeenCalled();
    expect(dialed).toEqual([]);
  });

  it('refuses a redirect hop to a host that fails the predicate, before dialing it', async () => {
    const srv = await server((req, res) => {
      res.writeHead(307, { location: `http://evil.test:${(req.socket.localPort ?? 0)}/next` });
      res.end();
    });
    close = srv.close;
    __setLookupForTests(async () => [{ address: '8.8.4.4', family: 4 }]);
    const dialed = recordDials();
    await expect(
      safeFetchFollowingRedirects(`http://good.test:${srv.port}/start`, {}, undefined, {
        allowHost: (u) => u.hostname === 'good.test',
      }),
    ).rejects.toThrow(/evil\.test/);
    expect(dialed.map((d) => d.host)).toEqual(['good.test']);
    expect(srv.requests()).toBe(1);
  });

  it('follows a redirect to an allowed host (each hop still pinned)', async () => {
    const srv = await server((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://cdn.good.test:${req.socket.localPort}/end` });
        res.end();
        return;
      }
      res.end('done');
    });
    close = srv.close;
    __setLookupForTests(async () => [{ address: '8.8.4.4', family: 4 }]);
    const dialed = recordDials();
    const res = await safeFetchFollowingRedirects(`http://good.test:${srv.port}/start`, {}, undefined, {
      allowHost: (u) => u.hostname.endsWith('good.test'),
    });
    expect(await res.text()).toBe('done');
    expect(dialed.map((d) => d.host)).toEqual(['good.test', 'cdn.good.test']);
  });

  it('a redirect to an allowed host that resolves to a private address is still refused', async () => {
    const srv = await server((req, res) => {
      res.writeHead(302, { location: `http://inner.good.test:${req.socket.localPort}/end` });
      res.end();
    });
    close = srv.close;
    __setLookupForTests(async (host: string) =>
      host === 'inner.good.test' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '8.8.4.4', family: 4 }],
    );
    recordDials();
    await expect(
      safeFetchFollowingRedirects(`http://good.test:${srv.port}/start`, {}, undefined, {
        allowHost: (u) => u.hostname.endsWith('good.test'),
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(srv.requests()).toBe(1);
  });
});
