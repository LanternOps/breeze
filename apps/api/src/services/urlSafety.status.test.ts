/**
 * safeFetch against a REAL socket: the Node HTTP parser, real status lines and
 * real timing. The URL policy is evaluated against a public-looking test
 * record; only the final TCP dial is redirected to a local server (by wrapping
 * `http.request`'s `lookup`), so every policy and response-construction path
 * runs exactly as in production.
 *
 * Covers responses that cannot be represented as a plain `Response` with a
 * body (204/205/304, statuses outside 200-599) and requests that end without
 * a usable response (protocol upgrade, CONNECT, early close, abort).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo, LookupFunction } from 'net';
import { safeFetch, __setLookupForTests } from './urlSafety';

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

/** A raw TCP server that answers the first bytes of every connection with `reply`. */
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

/** 'pending' when `p` has not settled within `ms`. */
async function outcomeWithin(p: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<'pending'>((r) => { timer = setTimeout(() => r('pending'), ms); });
  try {
    return await Promise.race([p.then(() => 'resolved' as const, () => 'rejected' as const), pending]);
  } finally {
    clearTimeout(timer);
  }
}

describe('safeFetch — every outcome settles the promise and nothing escapes a socket callback', () => {
  const uncaught = vi.fn();
  let close: (() => void) | undefined;

  beforeEach(() => {
    uncaught.mockReset();
    process.on('uncaughtException', uncaught);
    __setLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    dialLocally();
  });

  afterEach(async () => {
    // Give any late socket callback a chance to throw before we look.
    await new Promise((r) => setTimeout(r, 20));
    process.off('uncaughtException', uncaught);
    close?.();
    close = undefined;
    __setLookupForTests(null);
    vi.restoreAllMocks();
    expect(uncaught).not.toHaveBeenCalled();
  });

  for (const streamResponse of [false, true]) {
    const mode = streamResponse ? 'streamed' : 'buffered';

    describe(`${mode} — empty-body statuses`, () => {
      it('a 204 with no body resolves with a null body', async () => {
        const s = await rawServer('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
        close = s.close;
        const res = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(res.status).toBe(204);
        expect(res.body).toBeNull();
      }, 5000);

      it('a 205 with no body resolves with a null body', async () => {
        const s = await rawServer('HTTP/1.1 205 Reset Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        close = s.close;
        const res = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(res.status).toBe(205);
        expect(res.body).toBeNull();
      }, 5000);

      it('a 205 that carries a body resolves with a null body', async () => {
        const s = await rawServer('HTTP/1.1 205 Reset Content\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi');
        close = s.close;
        const res = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(res.status).toBe(205);
        expect(res.body).toBeNull();
      }, 5000);

      it('a 304 resolves with a null body and keeps its headers', async () => {
        const s = await rawServer('HTTP/1.1 304 Not Modified\r\nETag: "a"\r\nConnection: close\r\n\r\n');
        close = s.close;
        const res = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(res.status).toBe(304);
        expect(res.headers.get('etag')).toBe('"a"');
        expect(res.body).toBeNull();
      }, 5000);

      it('a 204 that also sends body bytes settles normally', async () => {
        // Node's parser may flag the trailing bytes before the response ends;
        // either outcome is fine as long as it is an ordinary settle, and a
        // resolve carries a null body.
        const s = await rawServer('HTTP/1.1 204 No Content\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello');
        close = s.close;
        const outcome = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse }).then(
          (res) => ({ res }),
          (err: unknown) => ({ err })
        );
        if ('res' in outcome) {
          expect(outcome.res.status).toBe(204);
          expect(outcome.res.body).toBeNull();
        } else {
          expect(outcome.err).toBeInstanceOf(Error);
        }
      }, 5000);
    });

    describe(`${mode} — out-of-range statuses`, () => {
      for (const status of [600, 999]) {
        it(`a ${status} rejects with an ordinary Error`, async () => {
          const s = await rawServer(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
          close = s.close;
          const err = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse }).then(
            () => null,
            (e: unknown) => e
          );
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toMatch(new RegExp(`invalid HTTP status \\(${status}\\)`));
        }, 5000);
      }

      it('an ordinary 200 is unchanged', async () => {
        const s = await rawServer('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}');
        close = s.close;
        const res = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(res.status).toBe(200);
        expect(res.statusText).toBe('OK');
        expect(await res.json()).toEqual({ ok: true });
      }, 5000);
    });

    describe(`${mode} — requests that end without a usable response`, () => {
      it('a 101 Switching Protocols on a held-open socket rejects within 2 s', async () => {
        const s = await rawServer((sock) => {
          sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
        close = s.close;
        const p = safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(await outcomeWithin(p, 2000)).toBe('rejected');
        await expect(p).rejects.toThrow(/upgrade/i);
      }, 5000);

      it('a 101 followed by close rejects within 2 s', async () => {
        const s = await rawServer('HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n');
        close = s.close;
        const p = safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(await outcomeWithin(p, 2000)).toBe('rejected');
      }, 5000);

      it('a CONNECT answered with 200 rejects within 2 s', async () => {
        const s = await rawServer((sock) => {
          sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
        });
        close = s.close;
        const p = safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse, method: 'CONNECT' });
        expect(await outcomeWithin(p, 2000)).toBe('rejected');
      }, 5000);

      it('a connection ended after reading the request, with no response, rejects within 2 s', async () => {
        const s = await rawServer((sock) => { sock.end(); });
        close = s.close;
        const p = safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(await outcomeWithin(p, 2000)).toBe('rejected');
      }, 5000);

      it('a socket destroyed after reading the request, with no response, rejects within 2 s', async () => {
        const s = await rawServer((sock) => { sock.destroy(); });
        close = s.close;
        const p = safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse });
        expect(await outcomeWithin(p, 2000)).toBe('rejected');
      }, 5000);

      it('an abort while waiting for the response rejects with an abort error', async () => {
        const s = await rawServer(() => { /* never answers */ });
        close = s.close;
        const ac = new AbortController();
        const p = safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse, signal: ac.signal });
        setTimeout(() => ac.abort(), 50);
        expect(await outcomeWithin(p, 2000)).toBe('rejected');
        await expect(p).rejects.toThrow('aborted');
      }, 5000);

      it('an abort after a 101 still settles the promise', async () => {
        const s = await rawServer((sock) => {
          sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
        close = s.close;
        const ac = new AbortController();
        const p = safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse, signal: ac.signal });
        setTimeout(() => ac.abort(), 100);
        expect(await outcomeWithin(p, 2000)).toBe('rejected');
      }, 5000);
    });
  }

  it('streamed: a multi-chunk 200 is delivered whole', async () => {
    const s = await rawServer((sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nabcd');
      setTimeout(() => sock.write('efgh'), 20);
      setTimeout(() => sock.end('ijkl'), 40);
    });
    close = s.close;
    const res = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse: true });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abcdefghijkl');
  }, 5000);

  it('streamed: an abort after the body is handed out errors the body stream', async () => {
    const s = await rawServer((sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc');
    });
    close = s.close;
    const ac = new AbortController();
    const res = await safeFetch(`http://upstream.example:${s.port}/x`, { streamResponse: true, signal: ac.signal });
    expect(res.status).toBe(200);
    const text = res.text();
    setTimeout(() => ac.abort(), 50);
    expect(await outcomeWithin(text, 2000)).toBe('rejected');
  }, 5000);

  it('buffered: an abort mid-body rejects', async () => {
    const s = await rawServer((sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc');
    });
    close = s.close;
    const ac = new AbortController();
    const p = safeFetch(`http://upstream.example:${s.port}/x`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    expect(await outcomeWithin(p, 2000)).toBe('rejected');
  }, 5000);

  it('buffered: a body cut short by the peer rejects instead of resolving a truncated buffer', async () => {
    const s = await rawServer((sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc');
      setTimeout(() => sock.destroy(), 20);
    });
    close = s.close;
    const p = safeFetch(`http://upstream.example:${s.port}/x`);
    expect(await outcomeWithin(p, 2000)).toBe('rejected');
  }, 5000);
});
