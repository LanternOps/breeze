/**
 * A peer that answers with headers at once and then trickles its body, for
 * tests that measure when `safeFetch`'s overall bound ends a call.
 *
 * Timing: `safeFetch` arms its overall bound with the global `setTimeout`, so a
 * test fakes `setTimeout`/`clearTimeout` (`useFakeClock`) and moves the clock
 * to the exact moment (`clockTo`). Socket I/O stays real: the peer writes one
 * byte every 20 ms of REAL time, which keeps resetting the socket inactivity
 * timer (Node's own timer, not a global one), so only the overall bound can
 * end the call.
 *
 * The SSRF policy still sees the test record from `resolveTo`; only the final
 * dial is redirected to the local server (`dialLocally`).
 */
import http from 'http';
import https from 'https';
import net from 'net';
import type { AddressInfo, LookupFunction } from 'net';
import { expect, vi } from 'vitest';
import { __setLookupForTests } from '../../services/urlSafety';

const realHttpRequest = http.request;
const realHttpsRequest = https.request;

/** Fake the global timers safeFetch's bound uses. `Date` and socket timers stay real. */
export function useFakeClock(): { clockTo: (ms: number) => Promise<void> } {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = 0;
  return {
    /** Move the fake clock to `ms` after `useFakeClock`, then let real I/O run. */
    async clockTo(ms: number): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms - now);
      now = ms;
      await turns();
    },
  };
}

/** A few real event-loop turns (setImmediate is never faked). */
export async function turns(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Wait, in real time, for something driven by real socket I/O. */
export async function until(cond: () => boolean, what: string, limitMs = 20_000): Promise<void> {
  const started = performance.now();
  while (!cond()) {
    if (performance.now() - started > limitMs) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

export interface Tracked<T> {
  settled: boolean;
  value?: T;
  error?: unknown;
}

export function track<T>(p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { settled: false };
  p.then(
    (value) => { t.settled = true; t.value = value; },
    (error: unknown) => { t.settled = true; t.error = error; },
  );
  return t;
}

/**
 * Pending just before `ms` on the fake clock, settled just after. Returns the
 * settled tracker so the caller can assert the value or the error.
 */
export async function expectSettlesAt<T>(
  clockTo: (ms: number) => Promise<void>,
  t: Tracked<T>,
  ms: number,
): Promise<Tracked<T>> {
  await clockTo(ms - 1);
  expect(t.settled, `expected the call to still be pending at ${ms - 1} ms`).toBe(false);
  await clockTo(ms + 1);
  await until(() => t.settled, `the call to end at ${ms} ms`);
  return t;
}

/** Make every hostname resolve to `ip` for the SSRF policy. */
export function resolveTo(ip: string): void {
  __setLookupForTests(async () => [{ address: ip, family: 4 }]);
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
 * Route the pinned dial to 127.0.0.1. `headers()` counts responses whose
 * headers the client has parsed.
 */
export function dialLocally(): { headers: () => number } {
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

export interface SlowPeer {
  port: number;
  /** Requests received so far. */
  requests: () => number;
  close: () => void;
}

/**
 * A raw HTTP/1.1 server. With `body`, it answers 200 with that JSON at once
 * (a function receives the server's own port, for a document that names it).
 * Without it, it sends 200 headers declaring a 100,000-byte JSON body and then
 * one byte every 20 ms of real time, so the body never completes.
 */
export async function slowPeer(opts: { body?: unknown } = {}): Promise<SlowPeer> {
  let port = 0;
  const sockets: net.Socket[] = [];
  let requests = 0;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on('error', () => {});
    sock.once('data', () => {
      requests++;
      if (opts.body !== undefined) {
        const json = JSON.stringify(typeof opts.body === 'function' ? opts.body(port) : opts.body);
        sock.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
          + `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
        );
        return;
      }
      sock.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n'
        + 'Content-Length: 100000\r\nConnection: close\r\n\r\n{',
      );
      const timer = setInterval(() => (sock.destroyed ? clearInterval(timer) : sock.write(' ')), 20);
      sock.on('close', () => clearInterval(timer));
    });
  });
  // The trickle's `setInterval` stays real: `useFakeClock` fakes only setTimeout/clearTimeout.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    requests: () => requests,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
