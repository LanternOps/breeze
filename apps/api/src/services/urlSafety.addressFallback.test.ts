/**
 * safeFetch tries the next address from the SAME validated resolution when the
 * connection to one address fails or stalls before it is established (#11641).
 *
 * The policy sees test records (8.8.x.x / 10.0.0.x); a fake dialer reads the
 * address each attempt's own pinned lookup hands back and routes that attempt
 * to a refused port, a stalled socket or a local server. Every dial is
 * recorded, so a test can prove which addresses were (and were not) contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import https from 'https';
import net from 'net';
import { EventEmitter } from 'events';
import type { AddressInfo, LookupFunction } from 'net';
import type { LookupAddress } from 'dns';
import {
  safeFetch,
  SsrfBlockedError,
  __setConnectAttemptTimeoutForTests,
  __setLookupForTests
} from './urlSafety';

const realHttpRequest = http.request;
const realHttpsRequest = https.request;

type Route =
  | { kind: 'refused' }
  | { kind: 'stall' } // TCP connect never completes (fake socket)
  | { kind: 'port'; port: number }; // real dial to a local server on this port

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  __setLookupForTests(null);
  __setConnectAttemptTimeoutForTests(null);
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** A port nothing listens on (bound, read, released). */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function httpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.end('ok')
): Promise<{ port: number; requests: () => number }> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { port: (server.address() as AddressInfo).port, requests: () => requests };
}

/** A raw TCP server; `onConnection` decides what each accepted socket does. */
async function rawServer(onConnection: (sock: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    onConnection(sock);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** A request whose TCP connect never completes; destroy() fails it like Node does. */
function stalledRequest(): http.ClientRequest {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const socket = Object.assign(new EventEmitter(), { connecting: true });
  let destroyed = false;
  req.write = vi.fn();
  req.end = vi.fn(() => {
    process.nextTick(() => req.emit('socket', socket));
  });
  req.setTimeout = vi.fn();
  req.destroy = vi.fn((err?: Error) => {
    if (destroyed) return req;
    destroyed = true;
    process.nextTick(() => {
      if (err) req.emit('error', err);
      req.emit('close');
    });
    return req;
  });
  return req as unknown as http.ClientRequest;
}

const toLoopback: LookupFunction = (_host, opts, done) => {
  const callback = (typeof opts === 'function' ? opts : done) as (...a: unknown[]) => void;
  if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return;
  }
  callback(null, '127.0.0.1', 4);
};

/**
 * Route every dial by the address its own pinned lookup returns. Returns the
 * ordered list of addresses dialed. An address with no route fails the test.
 */
function fakeDialer(routes: Record<string, Route>, refusedPort: number): string[] {
  const dialed: string[] = [];
  const install = (mod: typeof http | typeof https, real: typeof http.request) => {
    vi.spyOn(mod, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
      let pinned: LookupAddress[] = [];
      options.lookup!(String(options.host), { all: true }, (err, addrs) => {
        if (err) throw err;
        pinned = addrs as unknown as LookupAddress[];
      });
      // The pinned lookup answers synchronously and with exactly one record.
      expect(pinned).toHaveLength(1);
      const address = pinned[0]!.address;
      dialed.push(address);
      const route = routes[address];
      if (!route) throw new Error(`dialed an address with no route: ${address}`);
      if (route.kind === 'stall') return stalledRequest();
      const port = route.kind === 'refused' ? refusedPort : route.port;
      return real({ ...options, port, lookup: toLoopback }, cb);
    }) as never);
  };
  install(http, realHttpRequest);
  install(https, realHttpsRequest);
  return dialed;
}

function resolvesTo(...ips: string[]): { calls: () => number } {
  let calls = 0;
  __setLookupForTests(async () => {
    calls++;
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
  return { calls: () => calls };
}

describe('safeFetch — falls back across the validated addresses (#11641)', () => {
  it('uses the second address when the first refuses the connection', async () => {
    const srv = await httpServer();
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'refused' }, '8.8.4.4': { kind: 'port', port: srv.port } },
      await closedPort()
    );
    const dns = resolvesTo('8.8.8.8', '8.8.4.4');

    const res = await safeFetch('http://release.example.test/x');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4']);
    expect(dns.calls()).toBe(1);
    expect(srv.requests()).toBe(1);
  });

  it('moves on when the first address stalls during connect instead of waiting out timeoutMs', async () => {
    __setConnectAttemptTimeoutForTests(50);
    const srv = await httpServer();
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'stall' }, '8.8.4.4': { kind: 'port', port: srv.port } },
      await closedPort()
    );
    resolvesTo('8.8.8.8', '8.8.4.4');

    const started = Date.now();
    const res = await safeFetch('http://release.example.test/x', { timeoutMs: 30_000 });

    expect(res.status).toBe(200);
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('moves on when the TLS handshake to the first address stalls', async () => {
    __setConnectAttemptTimeoutForTests(100);
    // Accepts TCP, never answers the ClientHello.
    const stallPort = await rawServer(() => {});
    const refused = await closedPort();
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'port', port: stallPort }, '8.8.4.4': { kind: 'refused' } },
      refused
    );
    resolvesTo('8.8.8.8', '8.8.4.4');

    const err = await safeFetch('https://release.example.test/x', { timeoutMs: 30_000 }).catch((e) => e);

    // The second (last) address's own failure is what the caller sees.
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('never dials an address that failed the policy, even while falling back', async () => {
    const srv = await httpServer();
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'refused' }, '8.8.4.4': { kind: 'port', port: srv.port } },
      await closedPort()
    );
    resolvesTo('8.8.8.8', '10.0.0.5', '127.0.0.1', '169.254.169.254', '8.8.4.4');

    const res = await safeFetch('http://release.example.test/x');

    expect(res.status).toBe(200);
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('does not re-resolve between attempts, so a rebinding resolver cannot inject an address', async () => {
    const srv = await httpServer();
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'refused' }, '8.8.4.4': { kind: 'port', port: srv.port } },
      await closedPort()
    );
    let calls = 0;
    __setLookupForTests(async () => {
      calls++;
      // First answer is public; any later answer would rebind to loopback.
      return calls === 1
        ? [{ address: '8.8.8.8', family: 4 }, { address: '8.8.4.4', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    });

    const res = await safeFetch('http://release.example.test/x');

    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4']);
  });

  it('gives up with the last error after a bounded number of attempts', async () => {
    const dialed = fakeDialer(
      {
        '8.8.8.1': { kind: 'refused' },
        '8.8.8.2': { kind: 'refused' },
        '8.8.8.3': { kind: 'refused' },
        '8.8.8.4': { kind: 'refused' },
        '8.8.8.5': { kind: 'refused' }
      },
      await closedPort()
    );
    resolvesTo('8.8.8.1', '8.8.8.2', '8.8.8.3', '8.8.8.4', '8.8.8.5');

    const err = await safeFetch('http://release.example.test/x').catch((e) => e);

    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(dialed).toEqual(['8.8.8.1', '8.8.8.2', '8.8.8.3']);
  });

  it('a single address keeps the existing behaviour: no extra attempt, the error is returned as is', async () => {
    const dialed = fakeDialer({ '8.8.8.8': { kind: 'refused' } }, await closedPort());
    resolvesTo('8.8.8.8');

    const err = await safeFetch('http://release.example.test/x').catch((e) => e);

    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(dialed).toEqual(['8.8.8.8']);
  });

  it('does not retry once the connection is established (the request may have been sent)', async () => {
    // Accepts the connection, reads the request, then resets it.
    const resetPort = await rawServer((sock) => sock.once('data', () => sock.destroy()));
    const srv = await httpServer();
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'port', port: resetPort }, '8.8.4.4': { kind: 'port', port: srv.port } },
      await closedPort()
    );
    resolvesTo('8.8.8.8', '8.8.4.4');

    await expect(
      safeFetch('http://release.example.test/x', { method: 'POST', body: 'payload' })
    ).rejects.toThrow();
    expect(dialed).toEqual(['8.8.8.8']);
    expect(srv.requests()).toBe(0);
  });

  it('does not retry a TLS handshake that fails (as opposed to stalls)', async () => {
    // Answers the ClientHello with bytes that are not TLS.
    const garbagePort = await rawServer((sock) => sock.once('data', () => sock.write('HTTP/1.1 400 Bad\r\n\r\n')));
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'port', port: garbagePort }, '8.8.4.4': { kind: 'refused' } },
      await closedPort()
    );
    resolvesTo('8.8.8.8', '8.8.4.4');

    const err = await safeFetch('https://release.example.test/x').catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).not.toBe('ECONNREFUSED');
    expect(dialed).toEqual(['8.8.8.8']);
  });

  it('does not fall back after the caller aborts', async () => {
    __setConnectAttemptTimeoutForTests(10_000);
    const dialed = fakeDialer(
      { '8.8.8.8': { kind: 'stall' }, '8.8.4.4': { kind: 'refused' } },
      await closedPort()
    );
    resolvesTo('8.8.8.8', '8.8.4.4');
    const ac = new AbortController();

    const pending = safeFetch('http://release.example.test/x', { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);

    await expect(pending).rejects.toThrow('aborted');
    expect(dialed).toEqual(['8.8.8.8']);
  });

  it('requirePrivateForCleartext: the fallback only dials private addresses for cleartext', async () => {
    const srv = await httpServer();
    const dialed = fakeDialer(
      { '10.0.0.5': { kind: 'refused' }, '10.0.0.6': { kind: 'port', port: srv.port } },
      await closedPort()
    );
    resolvesTo('10.0.0.5', '8.8.4.4', '10.0.0.6');

    const res = await safeFetch('http://appliance.example.test/x', {
      allowPrivateNetwork: true,
      requirePrivateForCleartext: true
    });

    expect(res.status).toBe(200);
    expect(dialed).toEqual(['10.0.0.5', '10.0.0.6']);
  });

  it('requirePrivateForCleartext: a public FIRST address is still refused before any dial', async () => {
    const dialed = fakeDialer({}, await closedPort());
    resolvesTo('8.8.4.4', '10.0.0.6');

    await expect(
      safeFetch('http://appliance.example.test/x', { allowPrivateNetwork: true, requirePrivateForCleartext: true })
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(dialed).toEqual([]);
  });

  it('reports each dialed address to onConnect, the last one being the address used', async () => {
    const srv = await httpServer();
    fakeDialer(
      { '8.8.8.8': { kind: 'refused' }, '8.8.4.4': { kind: 'port', port: srv.port } },
      await closedPort()
    );
    resolvesTo('8.8.8.8', '8.8.4.4');
    const onConnect = vi.fn();

    await safeFetch('http://release.example.test/x', { onConnect });

    expect(onConnect.mock.calls).toEqual([['8.8.8.8'], ['8.8.4.4']]);
  });
});
