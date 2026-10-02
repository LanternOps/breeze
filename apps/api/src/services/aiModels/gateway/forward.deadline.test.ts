/**
 * forwardUpstream's connect/headers deadline against a REAL socket (real
 * safeFetch, real Node HTTP parser). The deadline is shrunk so the test runs
 * in milliseconds; the SSRF policy sees a public test record and only the
 * final TCP dial is routed to a local server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo, LookupFunction } from 'net';

vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: () => {} }));
vi.mock('./byoEndpointPolicy', async (orig) => ({
  ...(await orig<typeof import('./byoEndpointPolicy')>()),
  byoEgressAllowances: () => ({ allowPrivateNetwork: false, requirePrivateForCleartext: false }),
}));
// The headers deadline and the idle limit are shrunk so the tests run in
// milliseconds; both are mutable per test.
const knobs = vi.hoisted(() => ({ headersMs: 100, idleMs: 120_000 }));
vi.mock('./deadlines', async (orig) => ({
  ...(await orig<typeof import('./deadlines')>()),
  gatewayHeadersTimeoutMs: () => knobs.headersMs,
}));
vi.mock('./limits', async (orig) => ({
  ...(await orig<typeof import('./limits')>()),
  get GATEWAY_IDLE_TIMEOUT_MS() { return knobs.idleMs; },
}));

import { __setLookupForTests } from '../../urlSafety';
import { __resetGatewayFailureNotesForTests, takeGatewayFailureNote } from './failureNotes';
import { __setUpstreamFetchForTests, forwardUpstream } from './forward';
import type { GatewayGrantRecord } from './types';

const realRequest = http.request;

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
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.once('data', () => onRequest(sock));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

const grantFor = (port: number): GatewayGrantRecord => ({
  id: 'g1',
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: `http://llm.example.com:${port}/v1` },
  credential: { secret: 'sk-secret-123456' },
  wireModels: new Set(['m1']), orgId: 'o1', aiSessionId: 's1', purpose: 'dispatch',
  expiresAt: Number.MAX_SAFE_INTEGER, inFlight: new Set(),
});

describe('forwardUpstream — connect/headers deadline', () => {
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
    __resetGatewayFailureNotesForTests();
    knobs.headersMs = 100;
    knobs.idleMs = 120_000;
    vi.restoreAllMocks();
  });

  it('#7794: a headers timeout is logged (scrubbed, with ids) and noted for the session, and the error names the deadline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await rawServer(() => { /* never answers */ });
    close = s.close;
    await expect(forwardUpstream(grantFor(s.port), {
      url: `http://llm.example.com:${s.port}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}', stream: true,
    }, new AbortController().signal)).rejects.toMatchObject({
      status: 504, code: 'upstream_timeout', message: expect.stringMatching(/did not start responding within 0\.1 s/),
    });
    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).find((l) => l.includes('response-header deadline'));
    expect(logged).toBeDefined();
    expect(logged).toContain('grant g1');
    expect(logged).toContain('connection c1');
    expect(logged).not.toContain('sk-secret-123456');
    // The chat turn that owns this grant can now say why it failed.
    expect(takeGatewayFailureNote('s1')).toMatch(/did not start responding within 0\.1 s/);
  }, 5000);

  it('#7794: the idle limit never cuts a longer headers deadline short (headers late but inside the deadline)', async () => {
    knobs.headersMs = 1000;
    knobs.idleMs = 50;
    const body = '{"choices":[]}';
    const s = await rawServer((sock) => {
      // Silent for 6x the idle limit, then headers well inside the headers deadline.
      setTimeout(() => sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`), 300);
    });
    close = s.close;
    const res = await forwardUpstream(grantFor(s.port), {
      url: `http://llm.example.com:${s.port}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}', stream: false,
    }, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  }, 5000);

  it('a non-streamed response whose body outlasts the connect deadline is delivered, not timed out', async () => {
    const body = '{"choices":[]}';
    const s = await rawServer((sock) => {
      // Headers immediately, the body only after 3x the connect deadline.
      sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      setTimeout(() => sock.end(body), 300);
    });
    close = s.close;
    const res = await forwardUpstream(grantFor(s.port), {
      url: `http://llm.example.com:${s.port}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}', stream: false,
    }, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  }, 5000);

  it('headers that never arrive still fail at the connect deadline with a 504', async () => {
    const s = await rawServer(() => { /* never answers */ });
    close = s.close;
    const started = Date.now();
    await expect(forwardUpstream(grantFor(s.port), {
      url: `http://llm.example.com:${s.port}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}', stream: false,
    }, new AbortController().signal)).rejects.toMatchObject({ status: 504, code: 'upstream_timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  }, 5000);

  it('a stalled DNS lookup fails at the connect deadline with a 504', async () => {
    __setLookupForTests(() => new Promise(() => {}));
    const started = Date.now();
    await expect(forwardUpstream(grantFor(1), {
      url: 'http://llm.example.com:1/v1/models', method: 'GET', headers: {}, stream: false,
    }, new AbortController().signal)).rejects.toMatchObject({ status: 504, code: 'upstream_timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  }, 5000);

  it('a caller abort while headers are pending is a 499, not a timeout', async () => {
    const s = await rawServer(() => { /* never answers */ });
    close = s.close;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(forwardUpstream(grantFor(s.port), {
      url: `http://llm.example.com:${s.port}/v1/chat/completions`, method: 'POST', headers: {}, body: '{}', stream: false,
    }, ac.signal)).rejects.toMatchObject({ status: 499, code: 'client_aborted' });
  }, 5000);
});
