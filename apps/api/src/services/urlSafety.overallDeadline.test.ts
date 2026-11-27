/**
 * Every safeFetch call has a hard overall bound, by default (#12788).
 *
 * `timeoutMs` is a socket-INACTIVITY timer, and Node arms it on the socket only
 * once the TCP connect completes: a connect that never completes (packets
 * dropped, the socket sits in SYN_SENT) was bounded by the kernel's SYN retry
 * schedule, not by the caller's timeout. A call with no options at all had no
 * bound in any phase.
 *
 * The default bound has two parts. The response (DNS, connect, TLS, sending the
 * request, waiting for the headers) must arrive within max(30 s,
 * headersTimeoutMs, 2 × timeoutMs) plus the time to send the request body at
 * the minimum transfer rate. The body then gets the time to move its expected
 * size (Content-Length, capped by maxBytes) at that rate: at least 5 min, at
 * most 60 min, and 60 min when the size is unknown. An explicit `deadlineMs`
 * replaces both with one total.
 *
 * Timing: every timer safeFetch arms itself (the bound, the connect and attempt
 * timers, the DNS and headers timers) is a global `setTimeout`, so these tests
 * run them on a fake clock and assert the exact moment, which a slow runner
 * cannot shift. Socket I/O stays real; the tests wait for it to happen before
 * moving the clock. Node's socket inactivity timer is not a global timer: the
 * few tests that rely on it run in real time and assert only "fires, and not
 * before the bound".
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
  ResponseHeadersTimeoutError,
  transferAllowanceMs,
  __setConnectAttemptTimeoutForTests,
  __setDefaultDeadlineForTests,
  __setLookupForTests
} from './urlSafety';

const realHttpRequest = http.request;
const realHttpsRequest = https.request;

const cleanups: Array<() => void | Promise<void>> = [];

const MIN = 60_000;
/** The default response-by bound with no caller timeouts. */
const RESPONSE_BY_MS = 30_000;
/** The default body bound's floor and ceiling. */
const BODY_FLOOR_MS = 5 * MIN;
const BODY_CEILING_MS = 60 * MIN;
/** The minimum transfer rate the default bound assumes: 64 KiB/s. */
const RATE = 64 * 1024;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  __setLookupForTests(null);
  __setConnectAttemptTimeoutForTests(null);
  __setDefaultDeadlineForTests(null);
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

// ── Fake clock ─────────────────────────────────────────────────────────────

let fakeNow = 0;

/**
 * Fake the global timers and `Date` (a redirect chain measures what is left of
 * its bound with `Date.now()`). Node's socket inactivity timer stays real.
 */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  fakeNow = 0;
}

/** Move the fake clock to `ms` after `useFakeClock`, then let real I/O and nextTicks run. */
async function clockTo(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms - fakeNow);
  fakeNow = ms;
  await turns();
}

/** A few real event-loop turns (setImmediate is never faked). */
async function turns(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Wait, in real time, for something driven by real socket I/O. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > 20_000) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

interface Tracked<T> {
  settled: boolean;
  value?: T;
  error?: unknown;
}

function track<T>(p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { settled: false };
  p.then(
    (value) => { t.settled = true; t.value = value; },
    (error: unknown) => { t.settled = true; t.error = error; }
  );
  return t;
}

/** Pending just before `ms` on the fake clock, settled (rejected) just after. */
async function expectEndsAt<T>(t: Tracked<T>, ms: number): Promise<unknown> {
  await clockTo(ms - 1);
  expect(t.settled, `expected the request to still be pending at ${ms - 1} ms`).toBe(false);
  await clockTo(ms + 1);
  await until(() => t.settled, `the request to end at ${ms} ms`);
  expect(t.value).toBeUndefined();
  return t.error;
}

// ── Transport doubles ──────────────────────────────────────────────────────

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

/**
 * Route the pinned dial to 127.0.0.1 while the policy still sees the test
 * record. `headers()` counts responses whose headers the client has parsed:
 * the listener is added after safeFetch's own, so when it runs, safeFetch has
 * already seen the headers.
 */
function dialLocally(): { headers: () => number } {
  let seen = 0;
  const install = (mod: typeof http | typeof https, real: typeof http.request) => {
    vi.spyOn(mod, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
      const req = real({ ...options, lookup: toLoopback }, cb);
      req.on('response', () => { seen++; });
      return req;
    }) as never);
  };
  install(http, realHttpRequest);
  install(https, realHttpsRequest);
  return { headers: () => seen };
}

interface RawServer {
  port: number;
  /** Connections accepted so far. */
  accepted: net.Socket[];
  /** Connections that have sent at least one byte of a request. */
  requests: () => number;
}

/** A raw TCP server; `onRequest` runs on each connection's first request bytes. */
async function rawServer(onRequest?: (sock: net.Socket) => void): Promise<RawServer> {
  const accepted: net.Socket[] = [];
  let requests = 0;
  const server = net.createServer((sock) => {
    accepted.push(sock);
    sock.on('error', () => {});
    sock.once('data', () => {
      requests++;
      onRequest?.(sock);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const s of accepted) s.destroy();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, accepted, requests: () => requests };
}

/** The same error a timeout produced before this change: a plain Error with this message. */
function expectTimeoutError(error: unknown, ms: number): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ResponseDeadlineError);
  expect((error as Error).constructor).toBe(Error);
  expect((error as Error).message).toBe(`request timed out after ${ms}ms`);
}

const T = 30_000; // per-test budget: generous, the fake clock does the timing

// ── Connect ────────────────────────────────────────────────────────────────

describe('safeFetch — a connect that never completes ends at the configured timeout', () => {
  beforeEach(useFakeClock);

  it('http: fails at timeoutMs, not at the kernel\'s SYN schedule', async () => {
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x', { timeoutMs: 200 }));
    await until(() => dialed.length === 1, 'the dial');
    expectTimeoutError(await expectEndsAt(t, 200), 200);
  }, T);

  it('https: fails at timeoutMs, and the stalled socket is destroyed', async () => {
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('https://vendor.example.test/x', { method: 'POST', body: '{}', timeoutMs: 200 }));
    await until(() => dialed.length === 1, 'the dial');
    expectTimeoutError(await expectEndsAt(t, 200), 200);
    expect(stalledSockets.length).toBeGreaterThan(0);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, T);

  it('a 30 s client timeout with no deadline: the connect fails at 30 s, not at the longer overall bound', async () => {
    // The overall bound for this call is 60 s (twice timeoutMs); the connect
    // timer must still end a connect that never completes at timeoutMs.
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('https://vendor.example.test/x', { timeoutMs: 30_000 }));
    await until(() => dialed.length === 1, 'the dial');
    expectTimeoutError(await expectEndsAt(t, 30_000), 30_000);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, T);

  it('with several addresses, each stalled connect is bounded and the request still ends', async () => {
    // Earlier addresses get min(attempt timeout, timeoutMs); the last, which
    // had no bound at all, now gets timeoutMs too: 150 + 150 + 150.
    __setConnectAttemptTimeoutForTests(10_000);
    resolvesTo('8.8.8.8', '8.8.4.4', '1.1.1.1');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x', { timeoutMs: 150 }));
    await until(() => dialed.length === 1, 'the first dial');
    await clockTo(150);
    await until(() => dialed.length === 2, 'the second dial');
    await clockTo(300);
    await until(() => dialed.length === 3, 'the third dial');
    expectTimeoutError(await expectEndsAt(t, 450), 150);
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, T);
});

describe('safeFetch — the overall bound is for the whole request, not per resolved address', () => {
  beforeEach(useFakeClock);

  it('three stalled addresses end at one bound', async () => {
    // With no timeoutMs, each earlier address may take the 10 s attempt
    // timeout; only an overall bound ends the request at 300 ms.
    __setDefaultDeadlineForTests(300);
    __setConnectAttemptTimeoutForTests(10_000);
    resolvesTo('8.8.8.8', '8.8.4.4', '1.1.1.1');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x'));
    await until(() => dialed.length === 1, 'the dial');
    expectTimeoutError(await expectEndsAt(t, 300), 300);
    expect(dialed).toEqual(['8.8.8.8']);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, T);

  it('the bound keeps running across a fallback to the next address', async () => {
    // Each earlier address gets 200 ms; the bound (500 ms) ends the third at
    // 500 ms. A bound restarted per address would end it at 900 ms.
    __setDefaultDeadlineForTests(500);
    __setConnectAttemptTimeoutForTests(200);
    resolvesTo('8.8.8.8', '8.8.4.4', '1.1.1.1');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x'));
    await until(() => dialed.length === 1, 'the first dial');
    await clockTo(200);
    await until(() => dialed.length === 2, 'the second dial');
    await clockTo(400);
    await until(() => dialed.length === 3, 'the third dial');
    expectTimeoutError(await expectEndsAt(t, 500), 500);
    expect(dialed).toEqual(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
  }, T);
});

// ── Until the response arrives ─────────────────────────────────────────────

describe('safeFetch — the default bound until the response arrives', () => {
  beforeEach(useFakeClock);

  it('a DNS lookup that never returns ends at 30 s', async () => {
    __setLookupForTests(() => new Promise<never>(() => {}));
    const t = track(safeFetch('https://vendor.example.test/x'));
    expectTimeoutError(await expectEndsAt(t, RESPONSE_BY_MS), RESPONSE_BY_MS);
  }, T);

  it('a connect that never completes ends at 30 s', async () => {
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('https://vendor.example.test/x'));
    await until(() => dialed.length === 1, 'the dial');
    expectTimeoutError(await expectEndsAt(t, RESPONSE_BY_MS), RESPONSE_BY_MS);
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, T);

  it('a TLS handshake that stalls ends at 30 s, and the connection is closed', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer(); // reads the ClientHello, never answers it
    const t = track(safeFetch(`https://vendor.example.test:${server.port}/x`));
    await until(() => server.requests() === 1, 'the ClientHello');
    expectTimeoutError(await expectEndsAt(t, RESPONSE_BY_MS), RESPONSE_BY_MS);
    const sock = server.accepted[0]!;
    let ended = sock.readableEnded || sock.destroyed;
    sock.once('end', () => { ended = true; });
    sock.once('close', () => { ended = true; });
    sock.resume();
    await until(() => ended, 'the server side to see the connection end');
  }, T);

  it('headers that never arrive end at 30 s', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer(); // reads the request, never answers
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`));
    await until(() => server.requests() === 1, 'the request');
    expectTimeoutError(await expectEndsAt(t, RESPONSE_BY_MS), RESPONSE_BY_MS);
  }, T);

  it('with timeoutMs it allows two full timeouts: one to connect, one for the answer', async () => {
    // Connect and the wait for the answer can each take just under timeoutMs,
    // which worked before; a bound of max(30 s, timeoutMs) would cut that off.
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer();
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`, { timeoutMs: 20_000 }));
    await until(() => server.requests() === 1, 'the request');
    expectTimeoutError(await expectEndsAt(t, 40_000), 40_000);
  }, T);

  it('a server that answers after 45 s works under a 30 s timeoutMs (60 s to respond)', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => setTimeout(
      () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'),
      45_000
    ));
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`, { timeoutMs: 30_000 }));
    await until(() => server.requests() === 1, 'the request');
    await clockTo(45_000);
    await until(() => t.settled, 'the response');
    expect(t.error).toBeUndefined();
    expect(await t.value!.text()).toBe('ok');
  }, T);

  it('a large request body extends it by the time to send the body', async () => {
    // 30 × 64 KiB at 64 KiB/s = 30 s on top of the 30 s.
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.resume());
    const body = Buffer.alloc(30 * RATE, 0x61);
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/bulk`, { method: 'POST', body }));
    await until(() => server.requests() === 1, 'the request');
    expectTimeoutError(await expectEndsAt(t, 60_000), 60_000);
  }, T);

  it('never undercuts the caller\'s own timeoutMs or headersTimeoutMs', async () => {
    __setDefaultDeadlineForTests(200);
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => setTimeout(
      () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'),
      450
    ));
    for (const init of [{ timeoutMs: 2000 }, { headersTimeoutMs: 2000 }]) {
      const before = server.requests();
      const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`, init));
      await until(() => server.requests() === before + 1, 'the request');
      await clockTo(fakeNow + 450);
      await until(() => t.settled, 'the response');
      expect(t.error).toBeUndefined();
      expect(await t.value!.text()).toBe('ok');
    }
  }, T);

  it('the caller\'s timeoutMs, when longer, ends a stalled connect', async () => {
    __setDefaultDeadlineForTests(100);
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x', { timeoutMs: 300 }));
    await until(() => dialed.length === 1, 'the dial');
    expectTimeoutError(await expectEndsAt(t, 300), 300);
  }, T);

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('deadlineMs %s cannot disable it', async (deadlineMs) => {
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x', { deadlineMs }));
    await until(() => dialed.length === 1, 'the dial');
    expectTimeoutError(await expectEndsAt(t, RESPONSE_BY_MS), RESPONSE_BY_MS);
  }, T);

  it('a response that completes in time is unaffected', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`));
    await until(() => t.settled, 'the response');
    expect(await t.value!.text()).toBe('ok');
  }, T);
});

// ── The body ───────────────────────────────────────────────────────────────

/** Headers for a body of `length` bytes, or chunked when `length` is null. */
function head(length: number | null): string {
  return length === null
    ? 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
    : `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`;
}

describe('safeFetch — the default bound on the body', () => {
  beforeEach(useFakeClock);

  it.each([false, true])(
    'a body that trickles in steadily for 90 s under a 30 s timeoutMs succeeds (streamResponse %s)',
    async (streamResponse) => {
      // One byte a second: every byte resets the 30 s inactivity timer, as it
      // always has. Before, a 30 s total cut this off; a working slow vendor
      // must not fail.
      resolvesTo('8.8.8.8');
      const client = dialLocally();
      const server = await rawServer((sock) => {
        sock.write(head(90));
        let sent = 0;
        const next = (): void => {
          if (sock.destroyed) return;
          sent++;
          if (sent === 90) sock.end('x');
          else { sock.write('x'); setTimeout(next, 1000); }
        };
        setTimeout(next, 1000);
      });
      const t = track(safeFetch(`http://vendor.example.test:${server.port}/page`, { timeoutMs: 30_000, streamResponse })
        .then((res) => res.text()));
      await until(() => client.headers() === 1, 'the response headers');
      for (let s = 1; s <= 90; s++) await clockTo(s * 1000);
      await until(() => t.settled, 'the body');
      expect(t.error).toBeUndefined();
      expect(t.value).toBe('x'.repeat(90));
    },
    T
  );

  it('a body that stalls completely still fails on inactivity at timeoutMs (real time)', async () => {
    // Real timers: the inactivity timer is Node's own. Only the lower bound is
    // asserted, which a slow runner cannot break.
    vi.useRealTimers();
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(6)}abc`));
    const started = Date.now();
    const error = await safeFetch(`http://vendor.example.test:${server.port}/x`, { timeoutMs: 200 })
      .then(() => undefined, (err: unknown) => err);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expectTimeoutError(error, 200);
  }, T);

  it('a streamed body that stalls completely still fails on inactivity at timeoutMs (real time)', async () => {
    vi.useRealTimers();
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(6)}abc`));
    const res = await safeFetch(`http://vendor.example.test:${server.port}/x`, { timeoutMs: 200, streamResponse: true });
    const started = Date.now();
    const error = await res.text().then(() => undefined, (err: unknown) => err);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expectTimeoutError(error, 200);
  }, T);

  it.each([false, true])('a body that never finishes ends at 5 min for a small response (streamResponse %s)', async (streamResponse) => {
    // No timeoutMs, so nothing but the bound can end it.
    resolvesTo('8.8.8.8');
    const client = dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(1000)}abc`));
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`, { streamResponse }).then((res) => res.text()));
    await until(() => client.headers() === 1, 'the response headers');
    expectTimeoutError(await expectEndsAt(t, BODY_FLOOR_MS), BODY_FLOOR_MS);
  }, T);

  it('a body that keeps trickling in, resetting timeoutMs, still ends at the bound', async () => {
    // Each byte resets the inactivity timer, so before #12788 the request ran
    // as long as the peer kept sending. The trickle runs on real time.
    resolvesTo('8.8.8.8');
    const client = dialLocally();
    const server = await rawServer((sock) => {
      sock.write(head(1_000_000));
      const timer = setInterval(() => (sock.destroyed ? clearInterval(timer) : sock.write('x')), 20);
      sock.on('close', () => clearInterval(timer));
    });
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`, { timeoutMs: 20_000 }));
    await until(() => client.headers() === 1, 'the response headers');
    // 1,000,000 bytes at 64 KiB/s is under the 5 min floor.
    expectTimeoutError(await expectEndsAt(t, BODY_FLOOR_MS), BODY_FLOOR_MS);
  }, T);

  it('scales with Content-Length: 600 × 64 KiB gets 10 min', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(600 * RATE)}abc`));
    const res = await safeFetch(`http://vendor.example.test:${server.port}/big`, { streamResponse: true });
    const t = track(res.text());
    expectTimeoutError(await expectEndsAt(t, 10 * MIN), 10 * MIN);
  }, T);

  it('maxBytes caps the size the bound allows for', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(600 * RATE)}abc`));
    const res = await safeFetch(`http://vendor.example.test:${server.port}/big`, { streamResponse: true, maxBytes: 1024 * 1024 });
    const t = track(res.text());
    expectTimeoutError(await expectEndsAt(t, BODY_FLOOR_MS), BODY_FLOOR_MS);
  }, T);

  it('a chunked body sizes the bound from maxBytes: 20 MiB gets 320 s', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(null)}3\r\nabc\r\n`));
    const res = await safeFetch(`http://vendor.example.test:${server.port}/page`, { streamResponse: true, maxBytes: 20 * 1024 * 1024 });
    const t = track(res.text());
    expectTimeoutError(await expectEndsAt(t, 320_000), 320_000);
  }, T);

  it('a body of unknown size, with no maxBytes, gets the 60 min ceiling', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(null)}3\r\nabc\r\n`));
    const res = await safeFetch(`http://vendor.example.test:${server.port}/page`, { streamResponse: true });
    const t = track(res.text());
    expectTimeoutError(await expectEndsAt(t, BODY_CEILING_MS), BODY_CEILING_MS);
  }, T);

  it('a declared size past the ceiling still ends at 60 min', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(10 * 1024 * 1024 * 1024)}abc`));
    const res = await safeFetch(`http://vendor.example.test:${server.port}/huge`, { streamResponse: true });
    const t = track(res.text());
    expectTimeoutError(await expectEndsAt(t, BODY_CEILING_MS), BODY_CEILING_MS);
  }, T);

  // The clients that relied on `timeoutMs` alone before #12788, with the
  // options they pass today. Each must allow its largest body at well under
  // 1 Mbit/s (125,000 B/s), and still end a body that stops for good.
  it.each([
    // [client, timeoutMs, maxBytes, Content-Length or null (chunked), expected body bound]
    ['EDR guarded fetch, 20 MiB chunked page', 30_000, 20 * 1024 * 1024, null, 320_000], // 168 s at 1 Mbit/s
    ['EDR guarded fetch, 500 KB page', 30_000, 20 * 1024 * 1024, 500_000, BODY_FLOOR_MS],
    ['PSA, 8 MiB chunked page', 20_000, 8 * 1024 * 1024, null, BODY_FLOOR_MS], // 67 s at 1 Mbit/s
    ['UniFi, 10 MiB chunked', 15_000, 10 * 1024 * 1024, null, BODY_FLOOR_MS], // 84 s at 1 Mbit/s
    ['GitHub release API JSON, 8 MiB', 30_000, 8 * 1024 * 1024, null, BODY_FLOOR_MS], // 67 s at 1 Mbit/s
    ['Huntress / Pax8 page, 400 KB, no maxBytes', 20_000, undefined, 400_000, BODY_FLOOR_MS],
    ['Huntress / Pax8 page, chunked, no maxBytes', 20_000, undefined, null, BODY_CEILING_MS],
    ['8 MiB declared, no maxBytes', 20_000, undefined, 8 * 1024 * 1024, BODY_FLOOR_MS]
  ])('%s', async (_client, timeoutMs, maxBytes, length, expected) => {
    resolvesTo('8.8.8.8');
    const client = dialLocally();
    const server = await rawServer((sock) => sock.write(length === null ? `${head(null)}3\r\nabc\r\n` : `${head(length)}abc`));
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/page`, { timeoutMs, maxBytes }));
    await until(() => client.headers() === 1, 'the response headers');
    expectTimeoutError(await expectEndsAt(t, expected), expected);
  }, T);

  it('log forwarding: a 1.2 MB bulk upload under a 30 s timeoutMs gets 60 s + 19.2 s to be answered', async () => {
    // 2 × 30 s for connect and answer, plus 1,258,291 B at 64 KiB/s. The
    // upload takes about 10 s at 1 Mbit/s.
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.resume());
    const body = Buffer.alloc(1_258_291, 0x7b);
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/_bulk`, { method: 'POST', body, timeoutMs: 30_000 }));
    await until(() => server.requests() === 1, 'the request');
    const expected = 60_000 + Math.ceil((1_258_291 * 1000) / RATE);
    expect(expected).toBe(79_200);
    expectTimeoutError(await expectEndsAt(t, expected), expected);
  }, T);

  it('transferAllowanceMs is the time to move the bytes at 64 KiB/s', () => {
    expect(transferAllowanceMs(0)).toBe(0);
    expect(transferAllowanceMs(RATE)).toBe(1000);
    expect(transferAllowanceMs(256 * 1024 * 1024)).toBe(4096 * 1000);
    expect(transferAllowanceMs(1)).toBe(1);
  });
});

// ── An explicit deadlineMs ─────────────────────────────────────────────────

describe('safeFetch — an explicit deadlineMs replaces the default', () => {
  beforeEach(useFakeClock);

  it('a longer one lets a slow answer through', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => setTimeout(
      () => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'),
      45_000
    ));
    const t = track(safeFetch(`http://vendor.example.test:${server.port}/x`, { deadlineMs: 60_000 }));
    await until(() => server.requests() === 1, 'the request');
    await clockTo(45_000);
    await until(() => t.settled, 'the response');
    expect(t.error).toBeUndefined();
    expect(await t.value!.text()).toBe('ok');
  }, T);

  it('it fails with ResponseDeadlineError', async () => {
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x', { deadlineMs: 100 }));
    await until(() => dialed.length === 1, 'the dial');
    const error = await expectEndsAt(t, 100);
    expect(error).toBeInstanceOf(ResponseDeadlineError);
  }, T);

  it('it is one total: the body does not get a fresh allowance when the headers arrive', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.write(`${head(600 * RATE)}abc`));
    const res = await safeFetch(`http://vendor.example.test:${server.port}/big`, { streamResponse: true, deadlineMs: 1000 });
    const t = track(res.text());
    const error = await expectEndsAt(t, 1000);
    expect(error).toBeInstanceOf(ResponseDeadlineError);
  }, T);
});

// ── Phase timers ───────────────────────────────────────────────────────────

describe('safeFetch — phase timers take any number without overflowing', () => {
  // Node runs a timer past 2^31-1 ms after 1 ms. An infinite phase timer means
  // none, and a huge one is clamped; the overall bound still ends the request.
  it.each(['timeoutMs', 'headersTimeoutMs'])('%s Infinity sets no phase timer; the default bound ends it', async (option) => {
    useFakeClock();
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const t = track(safeFetch('http://vendor.example.test/x', { [option]: Number.POSITIVE_INFINITY }));
    await until(() => dialed.length === 1, 'the dial');
    const error = await expectEndsAt(t, RESPONSE_BY_MS);
    expectTimeoutError(error, RESPONSE_BY_MS);
    expect(error).not.toBeInstanceOf(ResponseHeadersTimeoutError);
  }, T);

  it.each(['timeoutMs', 'headersTimeoutMs'])('%s 2^31 does not fire at once (real time)', async (option) => {
    // The fake clock does not reproduce Node's overflow, so this runs on real
    // timers and asserts only that nothing has fired yet: an overflowed timer
    // is due after 1 ms and runs before the 100 ms check, however slow the runner.
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const ac = new AbortController();
    const t = track(safeFetch('http://vendor.example.test/x', { [option]: 2 ** 31, signal: ac.signal }));
    await until(() => dialed.length === 1 || t.settled, 'the dial');
    await new Promise((r) => setTimeout(r, 100));
    expect(t.settled).toBe(false);
    ac.abort();
    await until(() => t.settled, 'the abort');
  }, T);
});

// ── Redirect chains ────────────────────────────────────────────────────────

describe('safeFetchFollowingRedirects — the default bound covers the whole chain', () => {
  beforeEach(useFakeClock);

  it('a slow redirect followed by a hop that never answers ends at one bound, not one per hop', async () => {
    __setDefaultDeadlineForTests(600);
    resolvesTo('8.8.8.8');
    dialLocally();
    const target = await rawServer(); // never answers
    const redirect = await rawServer((sock) => setTimeout(() => sock.end(
      `HTTP/1.1 302 Found\r\nLocation: http://vendor.example.test:${target.port}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    ), 400));
    const t = track(safeFetchFollowingRedirects(`http://vendor.example.test:${redirect.port}/x`));
    await until(() => redirect.requests() === 1, 'the first hop');
    await clockTo(400);
    await until(() => target.requests() === 1, 'the second hop');
    // One bound per hop would end at 1000 ms.
    expectTimeoutError(await expectEndsAt(t, 600), 600);
  }, T);

  it.each([false, true])('a body that stalls after a redirect ends at the body bound (streamResponse %s)', async (streamResponse) => {
    resolvesTo('8.8.8.8');
    const client = dialLocally();
    const target = await rawServer((sock) => sock.write(`${head(6)}abc`));
    const redirect = await rawServer((sock) => sock.end(
      `HTTP/1.1 302 Found\r\nLocation: http://vendor.example.test:${target.port}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
    ));
    const t = track(safeFetchFollowingRedirects(`http://vendor.example.test:${redirect.port}/x`, { streamResponse })
      .then((res) => res.text()));
    await until(() => client.headers() === 2, 'the second hop\'s headers');
    expectTimeoutError(await expectEndsAt(t, BODY_FLOOR_MS), BODY_FLOOR_MS);
  }, T);
});

// ── Release and caller aborts ──────────────────────────────────────────────

describe('safeFetch — the bound is released and steps aside for the caller', () => {
  /** Bound timers still armed: only safeFetch arms timers on this path. */
  async function liveTimersAfter(run: () => Promise<unknown>): Promise<number> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await run().catch(() => {});
      // Let the request's 'close' (which releases the bound) run.
      await turns();
      return vi.getTimerCount();
    } finally {
      vi.useRealTimers();
    }
  }

  it('no bound timer outlives a finished request (buffered, streamed, cancelled, refused)', async () => {
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => sock.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
    const url = `http://vendor.example.test:${server.port}/x`;
    expect(await liveTimersAfter(async () => (await safeFetch(url)).text())).toBe(0);
    expect(await liveTimersAfter(async () => (await safeFetch(url, { timeoutMs: 5000 })).text())).toBe(0);
    expect(await liveTimersAfter(async () => (await safeFetch(url, { streamResponse: true })).text())).toBe(0);
    expect(await liveTimersAfter(async () => (await safeFetch(url, { streamResponse: true })).body!.cancel())).toBe(0);
    resolvesTo('10.0.0.5');
    expect(await liveTimersAfter(() => safeFetch(url))).toBe(0);
  }, T);

  it('a caller abort still settles as \'aborted\', not as the bound', async () => {
    useFakeClock();
    resolvesTo('8.8.8.8');
    const dialed = stallConnects();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t = track(safeFetch('http://vendor.example.test/x', { signal: ac.signal }));
    await until(() => dialed.length === 1, 'the dial');
    const error = await expectEndsAt(t, 50);
    expect((error as Error).message).toBe('aborted');
    expect(stalledSockets.every((s) => s.destroyed)).toBe(true);
  }, T);

  it('a streamed body outlives the default under a longer explicit deadlineMs', async () => {
    useFakeClock();
    resolvesTo('8.8.8.8');
    dialLocally();
    const server = await rawServer((sock) => {
      sock.write(`${head(6)}abc`);
      setTimeout(() => sock.end('def'), 2 * BODY_CEILING_MS);
    });
    const res = await safeFetch(`http://vendor.example.test:${server.port}/x`, { streamResponse: true, deadlineMs: 3 * BODY_CEILING_MS });
    const t = track(res.text());
    await clockTo(2 * BODY_CEILING_MS);
    await until(() => t.settled, 'the body');
    expect(t.error).toBeUndefined();
    expect(t.value).toBe('abcdef');
  }, T);
});
