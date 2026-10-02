/**
 * safeFetch deadlines against a REAL socket: DNS resolution honours the
 * caller's signal and deadlines, and headersTimeoutMs covers connect + headers
 * only. The SSRF policy is evaluated against a public-looking test record; only
 * the final TCP dial is redirected to a local server (by wrapping
 * `http.request`'s `lookup`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo, LookupFunction } from 'net';
import {
  safeFetch,
  ResponseHeadersTimeoutError,
  __setLookupForTests
} from './urlSafety';

const realRequest = http.request;

/** Route the pinned dial to 127.0.0.1 while the policy still sees 8.8.8.8. */
function dialLocally(): void {
  const toLoopback: LookupFunction = (_h, opts, cb) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
    if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
      return;
    }
    callback(null, '127.0.0.1', 4);
  };
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) =>
    realRequest({ ...options, lookup: toLoopback }, cb)) as never);
}

/** A raw TCP server that writes `reply` verbatim to every connection. */
async function rawServer(reply: string | ((sock: net.Socket) => void)): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.once('data', () => {
      if (typeof reply === 'string') {
        sock.end(reply);
      } else {
        reply(sock);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    }
  };
}


describe('safeFetch — DNS resolution honours the signal and deadlines', () => {
  afterEach(() => {
    __setLookupForTests(null);
    vi.restoreAllMocks();
  });

  const hang = () => new Promise<never>(() => {});

  it('an abort during a stalled lookup rejects promptly', async () => {
    __setLookupForTests(hang);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const started = Date.now();
    await expect(safeFetch('https://stalled.example/x', { signal: ac.signal })).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(200);
  }, 2000);

  it('an already-aborted signal rejects without waiting on the lookup', async () => {
    __setLookupForTests(hang);
    const ac = new AbortController();
    ac.abort();
    await expect(safeFetch('https://stalled.example/x', { signal: ac.signal })).rejects.toThrow('aborted');
  }, 2000);

  it('timeoutMs bounds a stalled lookup', async () => {
    __setLookupForTests(hang);
    const started = Date.now();
    await expect(safeFetch('https://stalled.example/x', { timeoutMs: 50 })).rejects.toThrow('request timed out after 50ms');
    expect(Date.now() - started).toBeLessThan(200);
  }, 2000);

  it('headersTimeoutMs bounds a stalled lookup', async () => {
    __setLookupForTests(hang);
    const started = Date.now();
    await expect(safeFetch('https://stalled.example/x', { headersTimeoutMs: 50 }))
      .rejects.toBeInstanceOf(ResponseHeadersTimeoutError);
    expect(Date.now() - started).toBeLessThan(200);
  }, 2000);
});

describe('safeFetch — headersTimeoutMs covers connect + headers only', () => {
  let close: (() => void) | undefined;

  beforeEach(() => {
    __setLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    dialLocally();
  });

  afterEach(() => {
    close?.();
    close = undefined;
    __setLookupForTests(null);
    vi.restoreAllMocks();
  });

  it('a buffered body that takes longer than the headers deadline still resolves', async () => {
    const s = await rawServer((sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc');
      setTimeout(() => sock.end('def'), 250);
    });
    close = s.close;
    const res = await safeFetch(`http://upstream.example:${s.port}/x`, { headersTimeoutMs: 100 });
    expect(await res.text()).toBe('abcdef');
  }, 5000);

  it('headers that never arrive reject at the headers deadline', async () => {
    const s = await rawServer(() => { /* never answers */ });
    close = s.close;
    const started = Date.now();
    await expect(safeFetch(`http://upstream.example:${s.port}/x`, { headersTimeoutMs: 100 }))
      .rejects.toBeInstanceOf(ResponseHeadersTimeoutError);
    expect(Date.now() - started).toBeLessThan(500);
  }, 5000);
});

