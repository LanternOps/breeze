/**
 * Discovery's total deadline against a REAL socket (real safeFetch, real Node
 * HTTP parser): an endpoint that answers headers at once and then trickles its
 * body — each byte well inside the inactivity limit — must not hold the
 * discovery worker past the total deadline. The deadline is shrunk so the test
 * runs in milliseconds; the SSRF policy sees a public test record and only the
 * final TCP dial is routed to a local server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo, LookupFunction } from 'net';

vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));
vi.mock('../byoEndpointPolicy', async (orig) => ({
  ...(await orig<typeof import('../byoEndpointPolicy')>()),
  byoEgressAllowances: () => ({ allowPrivateNetwork: false, requirePrivateForCleartext: false }),
}));
vi.mock('../limits', async (orig) => ({
  ...(await orig<typeof import('../limits')>()),
  DISCOVERY_TOTAL_TIMEOUT_MS: 200,
}));

import { __setLookupForTests } from '../../../urlSafety';
import { __setUpstreamFetchForTests } from '../forward';
import { DISCOVERY_TOTAL_TIMEOUT_MS } from '../limits';
import { discoverOpenAiCompatibleModels } from './discovery';

const realRequest = http.request;
const KEY = 'sk-discovery-deadline-123456';

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

async function rawServer(onRequest: (sock: net.Socket) => void): Promise<{ port: number; close: () => void }> {
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.once('data', () => onRequest(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => { for (const t of timers) clearInterval(t); for (const s of sockets) s.destroy(); server.close(); },
  };
}

const configFor = (port: number) => ({
  source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 1,
  baseUrl: `http://llm.example.com:${port}/v1`,
} as const);

describe('openai_compatible discovery — total deadline', () => {
  let close: (() => void) | undefined;

  beforeEach(() => {
    __setUpstreamFetchForTests(null);
    __setLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    dialLocally();
  });
  afterEach(() => {
    close?.();
    close = undefined;
    __setLookupForTests(null);
    vi.restoreAllMocks();
  });

  it('the production deadline is 30 s', async () => {
    const real = await vi.importActual<typeof import('../limits')>('../limits');
    expect(real.DISCOVERY_TOTAL_TIMEOUT_MS).toBe(30_000);
    expect(DISCOVERY_TOTAL_TIMEOUT_MS).toBe(200);
  });

  it('fast headers then a trickled body is cut off at the total deadline', async () => {
    const s = await rawServer((sock) => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n{"data":[');
      // One byte every 20 ms: always inside the inactivity limit, never finished.
      const t = setInterval(() => { if (!sock.destroyed) sock.write(' '); }, 20);
      sock.on('close', () => clearInterval(t));
    });
    close = s.close;
    const started = Date.now();
    const err = (await discoverOpenAiCompatibleModels({ config: configFor(s.port), credential: { secret: KEY } })
      .catch((e: unknown) => e)) as Error;
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/did not respond in time/);
    expect(err.message).not.toContain(KEY);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1500);
  }, 5000);

  it('a prompt, complete answer is unaffected', async () => {
    const body = '{"data":[{"id":"m1"}]}';
    const s = await rawServer((sock) => {
      sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
    close = s.close;
    await expect(discoverOpenAiCompatibleModels({ config: configFor(s.port), credential: { secret: KEY } }))
      .resolves.toEqual([{ modelId: 'm1', displayName: null }]);
  }, 5000);
});
