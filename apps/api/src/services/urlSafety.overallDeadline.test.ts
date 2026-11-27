/**
 * Every safeFetch call has a hard overall bound, by default (#12788).
 *
 * `timeoutMs` is a socket-INACTIVITY timer, and Node arms it on the socket only
 * once the TCP connect completes: a connect that never completes (packets
 * dropped, the socket sits in SYN_SENT) was bounded by the kernel's SYN retry
 * schedule, not by the caller's timeout. A call with no options at all had no
 * bound in any phase.
 *
 * The SSRF policy still sees public-looking test records; only the final dial is
 * redirected, either to a local server (real sockets) or to a socket that never
 * finishes connecting (a real `ClientRequest` over a `net.Socket` left in the
 * connecting state, so Node's own timeout semantics apply).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import https from 'https';
import net from 'net';
import type { AddressInfo, LookupFunction } from 'net';
import type { LookupAddress } from 'dns';
import {
  safeFetch,
  safeFetchFollowingRedirects,
  ResponseDeadlineError,
  __setConnectAttemptTimeoutForTests,
  __setDefaultDeadlineForTests,
  __setLookupForTests
} from './urlSafety';

const realHttpRequest = http.request;
const realHttpsRequest = https.request;

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  __setLookupForTests(null);
  __setConnectAttemptTimeoutForTests(null);
  __setDefaultDeadlineForTests(null);
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

function resolvesTo(...ips: string[]): void {
  __setLookupForTests(async () => ips.map((address) => ({ address, family: 4 })));
}

const toLoopback: LookupFunction = (_host, opts, done) => {
  const callback = (typeof opts === 'function' ? opts : done) as (...a: unknown[]) => void;
  if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return;
  }
  callback(null, '127.0.0.1', 4);
};

/** Sockets handed out by `stallConnects`, so a test can prove they were torn down. */
const stalledSockets: net.Socket[] = [];

/** A socket whose TCP connect never completes: Node sees `connecting` and waits on 'connect'. */
function neverConnectingSocket(): net.Socket {
  const sock = new net.Socket();
  (sock as unknown as { connecting: boolean }).connecting = true;
  stalledSockets.push(sock);
  return sock;
}

class StalledHttpAgent extends http.Agent {
  override createConnection(): net.Socket {
    return neverConnectingSocket();
  }
}
class StalledHttpsAgent extends https.Agent {
  override createConnection(): net.Socket {
    return neverConnectingSocket();
  }
}

/**
 * Every dial goes through a real `ClientRequest` whose socket never connects.
 * Returns the addresses dialed, read from each attempt's own pinned lookup.
 */
function stallConnects(): string[] {
  const dialed: string[] = [];
  stalledSockets.length = 0;
  const install = (mod: typeof http | typeof https, real: typeof http.request, agent: () => http.Agent) => {
    vi.spyOn(mod, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
      options.lookup!(String(options.host), { all: true }, (err, addrs) => {
        if (err) throw err;
        dialed.push((addrs as unknown as LookupAddress[])[0]!.address);
      });
      return real({ ...options, agent: agent() }, cb);
    }) as never);
  };
  install(http, realHttpRequest, () => new StalledHttpAgent());
  install(https, realHttpsRequest, () => new StalledHttpsAgent());
  return dialed;
}

/** Route the pinned dial to 127.0.0.1 while the policy still sees the test record. */
function dialLocally(): void {
  const install = (mod: typeof http | typeof https, real: typeof http.request) => {
    vi.spyOn(mod, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) =>
      real({ ...options, lookup: toLoopback }, cb)) as never);
  };
  install(http, realHttpRequest);
  install(https, realHttpsRequest);
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

/** Settle `p`, or report that it was still pending after `ms`. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ elapsed: number; error: unknown } | 'still pending'> {
  const started = Date.now();
  const outcome = p.then(
    () => ({ elapsed: Date.now() - started, error: undefined }),
    (error: unknown) => ({ elapsed: Date.now() - started, error })
  );
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<'still pending'>((resolve) => {
    timer = setTimeout(() => resolve('still pending'), ms);
  });
  try {
    return await Promise.race([outcome, pending]);
  } finally {
    clearTimeout(timer);
  }
}

/** The same error a timeout produced before this change: a plain Error with this message. */
function expectTimeoutError(error: unknown, ms: number): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ResponseDeadlineError);
  expect((error as Error).constructor).toBe(Error);
  expect((error as Error).message).toBe(`request timed out after ${ms}ms`);
}

describe('safeFetch — a connect that never completes ends at the configured timeout', () => {
  it('http: fails at timeoutMs, not at the kernel\'s SYN schedule', async () => {
    resolvesTo('8.8.8.8');
    stallConnects();
    const outcome = await settleWithin(safeFetch('http://vendor.example.test/x', { timeoutMs: 200 }), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
    expect(outcome.elapsed).toBeGreaterThanOrEqual(180);
    expect(outcome.elapsed).toBeLessThan(700);
  }, 5000);

  it('https: fails at timeoutMs, and the stalled socket is destroyed', async () => {
    resolvesTo('8.8.8.8');
    stallConnects();
    const outcome = await settleWithin(
      safeFetch('https://vendor.example.test/x', { method: 'POST', body: '{}', timeoutMs: 200 }),
      1500
    );
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
    expect(stalledSockets.length).toBeGreaterThan(0);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, 5000);

  it('with several addresses, each stalled connect is bounded and the request still ends', async () => {
    // Earlier addresses get min(attempt timeout, timeoutMs); the last, which
    // had no bound at all, now gets timeoutMs too.
    __setConnectAttemptTimeoutForTests(10_000);
    resolvesTo('8.8.8.8', '8.8.4.4', '1.1.1.1');
    const dialed = stallConnects();
    const outcome = await settleWithin(safeFetch('http://vendor.example.test/x', { timeoutMs: 150 }), 2500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 150);
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, 5000);
});

describe('safeFetch — the overall bound is for the whole request, not per resolved address', () => {
  it('three stalled addresses end at one bound', async () => {
    // With no timeoutMs, each earlier address may take the 10 s attempt
    // timeout; only an overall bound ends the request at 300 ms.
    __setDefaultDeadlineForTests(300);
    __setConnectAttemptTimeoutForTests(10_000);
    resolvesTo('8.8.8.8', '8.8.4.4', '1.1.1.1');
    const dialed = stallConnects();
    const outcome = await settleWithin(safeFetch('http://vendor.example.test/x'), 2500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 300);
    expect(outcome.elapsed).toBeLessThan(800);
    expect(dialed).toEqual(['8.8.8.8']);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, 5000);

  it('the bound keeps running across a fallback to the next address', async () => {
    // Each earlier address gets 200 ms; the bound (500 ms) ends the third.
    __setDefaultDeadlineForTests(500);
    __setConnectAttemptTimeoutForTests(200);
    resolvesTo('8.8.8.8', '8.8.4.4', '1.1.1.1');
    const dialed = stallConnects();
    const outcome = await settleWithin(safeFetch('http://vendor.example.test/x'), 2500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 500);
    expect(outcome.elapsed).toBeLessThan(1000);
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
  }, 5000);
});

describe('safeFetch — the default bound applies when the caller passes none', () => {
  beforeEach(() => {
    __setDefaultDeadlineForTests(200);
  });

  it('a DNS lookup that never returns', async () => {
    __setLookupForTests(() => new Promise<never>(() => {}));
    const outcome = await settleWithin(safeFetch('https://vendor.example.test/x'), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
    expect(outcome.elapsed).toBeLessThan(700);
  }, 5000);

  it('a connect that never completes', async () => {
    resolvesTo('8.8.8.8');
    stallConnects();
    const outcome = await settleWithin(safeFetch('https://vendor.example.test/x'), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
    expect(outcome.elapsed).toBeLessThan(700);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, 5000);

  it('a TLS handshake that stalls', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    let accepted: net.Socket | undefined;
    const port = await rawServer((sock) => {
      accepted = sock; // reads the ClientHello, never answers it
    });
    const outcome = await settleWithin(safeFetch(`https://vendor.example.test:${port}/x`), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
    expect(outcome.elapsed).toBeLessThan(700);
    // The client end hung up: the server side sees the connection end.
    expect(accepted).toBeDefined();
    const ended = await new Promise<boolean>((resolve) => {
      if (accepted!.readableEnded || accepted!.destroyed) return resolve(true);
      const timer = setTimeout(() => resolve(false), 1000);
      accepted!.once('end', () => { clearTimeout(timer); resolve(true); });
      accepted!.once('close', () => { clearTimeout(timer); resolve(true); });
      accepted!.resume();
    });
    expect(ended).toBe(true);
  }, 5000);

  it('headers that never arrive', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const port = await rawServer(() => { /* reads the request, never answers */ });
    const outcome = await settleWithin(safeFetch(`http://vendor.example.test:${port}/x`), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
  }, 5000);

  it('a buffered body that stalls midway', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const port = await rawServer((sock) => {
      sock.once('data', () => sock.write('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabc'));
    });
    const outcome = await settleWithin(safeFetch(`http://vendor.example.test:${port}/x`), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
  }, 5000);

  it('a streamed body that stalls midway fails the stream', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const port = await rawServer((sock) => {
      sock.once('data', () => sock.write('HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabc'));
    });
    const res = await safeFetch(`http://vendor.example.test:${port}/x`, { streamResponse: true });
    const outcome = await settleWithin(res.text(), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
  }, 5000);

  it('a body that keeps trickling in, resetting timeoutMs, ends at the bound', async () => {
    // Each byte resets the inactivity timer, so before this change the request
    // ran as long as the peer kept sending.
    resolvesTo('8.8.8.8');
    dialLocally();
    const port = await rawServer((sock) => {
      sock.once('data', () => {
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n');
        const timer = setInterval(() => (sock.destroyed ? clearInterval(timer) : sock.write('x')), 20);
        sock.on('close', () => clearInterval(timer));
      });
    });
    const outcome = await settleWithin(safeFetch(`http://vendor.example.test:${port}/x`, { timeoutMs: 100 }), 2000);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
    expect(outcome.elapsed).toBeGreaterThanOrEqual(180);
  }, 5000);

  it('never undercuts the caller\'s own timeoutMs or headersTimeoutMs', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const port = await rawServer((sock) => {
      sock.once('data', () => setTimeout(
        () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'),
        450
      ));
    });
    const viaTimeout = await safeFetch(`http://vendor.example.test:${port}/x`, { timeoutMs: 2000 });
    expect(await viaTimeout.text()).toBe('ok');
    const viaHeaders = await safeFetch(`http://vendor.example.test:${port}/x`, { headersTimeoutMs: 2000 });
    expect(await viaHeaders.text()).toBe('ok');
  }, 5000);

  it('the caller\'s timeoutMs, when longer, is the bound', async () => {
    resolvesTo('8.8.8.8');
    stallConnects();
    __setDefaultDeadlineForTests(100);
    const outcome = await settleWithin(safeFetch('http://vendor.example.test/x', { timeoutMs: 300 }), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 300);
    expect(outcome.elapsed).toBeGreaterThanOrEqual(280);
  }, 5000);

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('deadlineMs %s cannot disable it', async (deadlineMs) => {
    resolvesTo('8.8.8.8');
    stallConnects();
    const outcome = await settleWithin(safeFetch('http://vendor.example.test/x', { deadlineMs }), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 200);
  }, 5000);

  it('an explicit deadlineMs replaces it: a longer one lets a slow body finish', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const port = await rawServer((sock) => {
      sock.once('data', () => {
        sock.write('HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc');
        setTimeout(() => sock.end('def'), 450);
      });
    });
    const res = await safeFetch(`http://vendor.example.test:${port}/x`, { deadlineMs: 3000 });
    expect(await res.text()).toBe('abcdef');
  }, 5000);

  it('an explicit deadlineMs still fails with ResponseDeadlineError', async () => {
    resolvesTo('8.8.8.8');
    stallConnects();
    const outcome = await settleWithin(safeFetch('http://vendor.example.test/x', { deadlineMs: 100 }), 1500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expect(outcome.error).toBeInstanceOf(ResponseDeadlineError);
  }, 5000);

  it('a response that completes in time is unaffected', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const port = await rawServer((sock) => {
      sock.once('data', () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
    });
    const res = await safeFetch(`http://vendor.example.test:${port}/x`);
    expect(await res.text()).toBe('ok');
  }, 5000);
});

describe('safeFetchFollowingRedirects — the default bound covers the whole chain', () => {
  it('a slow redirect followed by a hop that never answers ends at one bound, not one per hop', async () => {
    __setDefaultDeadlineForTests(500);
    resolvesTo('8.8.8.8');
    dialLocally();
    const target = await rawServer(() => { /* never answers */ });
    const redirect = await rawServer((sock) => {
      sock.once('data', () => setTimeout(() => sock.end(
        `HTTP/1.1 302 Found\r\nLocation: http://vendor.example.test:${target}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      ), 350));
    });
    const outcome = await settleWithin(safeFetchFollowingRedirects(`http://vendor.example.test:${redirect}/x`), 2500);
    expect(outcome).not.toBe('still pending');
    if (outcome === 'still pending') return;
    expectTimeoutError(outcome.error, 500);
    // One bound per hop would end at ~850 ms.
    expect(outcome.elapsed).toBeLessThan(750);
  }, 5000);
});
