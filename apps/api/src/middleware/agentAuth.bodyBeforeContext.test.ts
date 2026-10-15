import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// #8839 — the REAL agentAuthMiddleware in front of a REAL `bodyLimit` +
// `zValidator('json')` route chain: a wrapped agent route must have its whole
// request body in memory BEFORE the request-long org transaction opens, so a
// stalled upload can never pin a pooled connection while the server waits for
// bytes. Only the database, Redis and tenant lookups are faked (same harness as
// agentAuth.storageSessionRateLimit.test.ts).

const events = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  withDbAccessContext: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) => {
    events.log.push('context-opened');
    return fn();
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id', agentId: 'agentId', orgId: 'orgId', siteId: 'siteId',
    agentTokenHash: 'agentTokenHash', previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt', watchdogTokenHash: 'watchdogTokenHash',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt', status: 'status',
    agentTokenSuspendedAt: 'agentTokenSuspendedAt', hostname: 'hostname', lastSeenIp: 'lastSeenIp',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  deviceMtlsCertificates: {
    deviceId: 'deviceMtlsCertificates.deviceId', state: 'deviceMtlsCertificates.state',
    serialNumber: 'deviceMtlsCertificates.serialNumber', createdAt: 'deviceMtlsCertificates.createdAt',
  },
}));

const redisHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services/rate-limit')>('../services/rate-limit');
  return {
    getRedis: vi.fn(() => redisHolder.current),
    rateLimiter: actual.rateLimiter,
  };
});

vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn(async () => undefined) }));

vi.mock('../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: vi.fn(() => '203.0.113.5'),
  trustsForwardedHeadersFrom: vi.fn(() => false),
}));

vi.mock('../services/tenantStatus', () => ({ getAgentTenantState: vi.fn(async () => 'active') }));
vi.mock('../services/deviceUninstallDrain', () => ({ isDeviceUninstallDraining: vi.fn(async () => false) }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  and: vi.fn((...args) => ({ and: args })),
  isNull: vi.fn((col) => ({ isNull: col })),
  desc: vi.fn((col) => ({ desc: col })),
  ne: vi.fn((left, right) => ({ ne: [left, right] })),
  count: vi.fn(() => ({ count: true })),
}));

vi.mock('../services/agentOrgRateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agentOrgRateLimit')>();
  return { ...actual, resolveOrgRateLimit: vi.fn(async () => actual.DEFAULT_AGENT_ORG_RATE_LIMIT) };
});

import { createHash } from 'crypto';
import { connect } from 'node:net';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { db, withDbAccessContext } from '../db';
import { zValidator } from '../lib/validation';
import { SortedSetRedisFake } from '../__tests__/helpers/sortedSetRedisFake';
import { metricsRegistry } from '../services/metricsRegistry';
import { bodyLimitForPath } from './bodyLimit';
import { agentAuthMiddleware } from './agentAuth';
import {
  AGENT_BODY_REJECTED_METRIC,
  AGENT_BODY_RECEIVE_TIMEOUT_MS,
  AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS,
  AGENT_WRAPPED_BODY_MAX_BYTES,
} from './agentRequestBody';

const TOKEN = 'brz_body_before_context_token';
const AGENT = 'agent-1';
const ROUTE_LIMIT = 1024;
const ROUTE_TOO_LARGE = 'Connections report too large (route limit)';

function mockDeviceLookup() {
  const terminal = { where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{
    id: 'device-1', agentId: AGENT, orgId: 'org-1', siteId: 'site-1', partnerId: 'partner-1',
    agentTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
    previousTokenHash: null, previousTokenExpiresAt: null, watchdogTokenHash: null,
    previousWatchdogTokenHash: null, previousWatchdogTokenExpiresAt: null,
    status: 'active', hostname: 'box-1', lastSeenIp: '203.0.113.5',
  }]) }) };
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue(terminal), ...terminal }),
  } as never);
}

const connectionsSchema = z.object({ connections: z.array(z.object({ port: z.number() })) });

const handled = vi.fn();

function buildApp() {
  const app = new Hono();
  app.use('/api/v1/agents/:id/*', agentAuthMiddleware);
  // A wrapped route shaped exactly like routes/agents/connections.ts.
  app.put(
    '/api/v1/agents/:id/connections',
    bodyLimit({ maxSize: ROUTE_LIMIT, onError: (c) => c.json({ error: ROUTE_TOO_LARGE }, 413) }),
    zValidator('json', connectionsSchema),
    (c) => {
      events.log.push('handler');
      const data = c.req.valid('json');
      handled(data);
      return c.json({ received: data.connections.length });
    },
  );
  // A wrapped route that reads the raw bytes itself, like routes/agents/logs.ts.
  app.on(['POST', 'PATCH'], '/api/v1/agents/:id/logs', async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    const decoded = c.req.header('content-encoding')?.includes('gzip') ? gunzipSync(raw) : raw;
    handled(decoded.toString('utf-8'));
    return c.json({ bytes: raw.byteLength });
  });
  // The REST command-result fallback: wrapped, no route bodyLimit, admitted up
  // to 12 MiB by the global gate (#2401).
  app.post('/api/v1/agents/:id/commands/:commandId/result', async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json({ bytes: bytes.byteLength, last: bytes[bytes.byteLength - 1] });
  });
  app.delete('/api/v1/agents/:id/things', async (c) => c.json(await c.req.json()));
  app.get('/api/v1/agents/:id/config', (c) => c.json({ ok: true }));
  // Self-managed routes answer without touching the body.
  app.post('/api/v1/agents/:id/heartbeat', (c) => {
    handled('heartbeat');
    return c.json({ ok: true });
  });
  app.post('/api/v1/agents/:id/storage-sessions/:sessionId/:op', (c) => c.json({ ok: true }));
  return app;
}

const auth = { authorization: `Bearer ${TOKEN}` };
const encoder = new TextEncoder();

/** A body stream that delivers `chunks` (one per pull) and then never resolves again. */
function stalledStream(chunks: string[] = []): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
        return;
      }
      return new Promise<void>(() => {});
    },
  });
}

/** A body stream that delivers each chunk after `delayMs`, then closes (recording when). */
function delayedStream(chunks: string[], delayMs: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
        return;
      }
      events.log.push('body-done');
      controller.close();
    },
  });
}

function streamRequest(app: Hono, path: string, body: ReadableStream<Uint8Array>, method = 'PUT') {
  return app.request(`/api/v1/agents/${AGENT}/${path}`, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);
}

async function rejectedCount(reason: string, route: string): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(AGENT_BODY_REJECTED_METRIC);
  const values = (await metric!.get()).values;
  return values.find((v) => v.labels.reason === reason && v.labels.route === route)?.value ?? 0;
}

describe('agentAuthMiddleware — request body is received before the org context opens (#8839)', () => {
  beforeEach(() => {
    events.log = [];
    handled.mockClear();
    vi.mocked(withDbAccessContext).mockClear();
    redisHolder.current = new SortedSetRedisFake();
    mockDeviceLookup();
    process.env.AGENT_BODY_RECEIVE_TIMEOUT_MS = '60';
    process.env.AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS = '400';
  });

  afterEach(() => {
    delete process.env.AGENT_BODY_RECEIVE_TIMEOUT_MS;
    delete process.env.AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('(a) a body that stalls after the headers is refused 408 and never opens the org context', async () => {
    const before = await rejectedCount('timeout', '/api/v1/agents/:id/connections');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await streamRequest(buildApp(), 'connections', stalledStream(['{"connections":[']));

    expect(res.status).toBe(408);
    expect(await res.json()).toEqual({ error: 'Request body not received in time' });
    expect(withDbAccessContext).not.toHaveBeenCalled();
    expect(handled).not.toHaveBeenCalled();
    expect(await rejectedCount('timeout', '/api/v1/agents/:id/connections')).toBe(before + 1);
    const line = warn.mock.calls.map((args) => String(args[0])).find((m) => m.includes('[agentAuth] request body'));
    expect(line).toContain('reason=timeout');
    expect(line).toContain('heldMs=0');
    expect(line).toContain('route=/api/v1/agents/:id/connections');
    expect(line).toContain(`agentId="${AGENT}"`);
    expect(line).toContain('orgId=org-1');
  });

  it('(a) a body with no bytes at all is refused on the same stall deadline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await streamRequest(buildApp(), 'connections', stalledStream());
    expect(res.status).toBe(408);
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });

  it('(a) a body that keeps dribbling bytes is still bounded by the total receive deadline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Each chunk arrives inside the 60 ms stall window, but the body never ends.
    let n = 0;
    const dribble = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        n += 1;
        controller.enqueue(encoder.encode(' '));
      },
    });
    const startedAt = Date.now();
    const res = await streamRequest(buildApp(), 'connections', dribble);
    expect(res.status).toBe(408);
    expect(n).toBeGreaterThan(3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });

  it('(b) a normal JSON body reaches the handler through bodyLimit + zValidator unchanged (Content-Length)', async () => {
    const payload = { connections: [{ port: 443 }, { port: 22 }] };
    const res = await buildApp().request(`/api/v1/agents/${AGENT}/connections`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 2 });
    expect(handled).toHaveBeenCalledWith(payload);
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('(b) a streamed (chunked, no Content-Length) JSON body reaches the handler unchanged', async () => {
    const res = await streamRequest(
      buildApp(),
      'connections',
      delayedStream(['{"connections":[{"port":', '8443}]}'], 5),
    );
    expect(res.status).toBe(200);
    expect(handled).toHaveBeenCalledWith({ connections: [{ port: 8443 }] });
  });

  it('(b) a route that reads raw bytes (logs-style arrayBuffer) gets the exact body', async () => {
    const res = await streamRequest(buildApp(), 'logs', delayedStream(['{"logs":', '[]}'], 5), 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 11 });
    expect(handled).toHaveBeenCalledWith('{"logs":[]}');
  });

  it('(b) a PATCH with a streamed body is buffered and delivered', async () => {
    const res = await streamRequest(buildApp(), 'logs', delayedStream(['{"a":', '1}'], 5), 'PATCH');
    expect(res.status).toBe(200);
    expect(handled).toHaveBeenCalledWith('{"a":1}');
    expect(events.log.indexOf('body-done')).toBeLessThan(events.log.indexOf('context-opened'));
  });

  it('(b) a gzip body keeps its Content-Encoding and decodes in the handler', async () => {
    const res = await buildApp().request(`/api/v1/agents/${AGENT}/logs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from('{"logs":["compressed"]}')),
    });
    expect(res.status).toBe(200);
    expect(handled).toHaveBeenCalledWith('{"logs":["compressed"]}');
  });

  it('(b) an empty POST body and a POST with no body both reach the handler', async () => {
    const app = buildApp();
    const empty = await app.request(`/api/v1/agents/${AGENT}/logs`, { method: 'POST', headers: auth, body: '' });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ bytes: 0 });
    const none = await app.request(`/api/v1/agents/${AGENT}/logs`, { method: 'POST', headers: auth });
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ bytes: 0 });
  });

  it('(b) an 8 MiB command result (above every route limit, below the ceiling) is delivered intact', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let sent = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 8) {
          controller.enqueue(new Uint8Array([42]));
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await streamRequest(buildApp(), 'commands/cmd-1/result', big, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 8 * 1024 * 1024 + 1, last: 42 });
  });

  it('(b) a DELETE with a body is buffered too', async () => {
    const res = await buildApp().request(`/api/v1/agents/${AGENT}/things`, {
      method: 'DELETE',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'x' });
  });

  it('(c) a body over the ROUTE bodyLimit still gets that route\'s own 413 message (Content-Length leg)', async () => {
    const res = await buildApp().request(`/api/v1/agents/${AGENT}/connections`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ connections: [], pad: 'x'.repeat(ROUTE_LIMIT * 2) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: ROUTE_TOO_LARGE });
    expect(handled).not.toHaveBeenCalled();
  });

  it('(c) a body over the ROUTE bodyLimit still gets that route\'s own 413 message (streaming leg)', async () => {
    const res = await streamRequest(
      buildApp(),
      'connections',
      delayedStream(['{"connections":[],"pad":"', 'x'.repeat(ROUTE_LIMIT * 2), '"}'], 1),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: ROUTE_TOO_LARGE });
    expect(handled).not.toHaveBeenCalled();
  });

  it('(c) a body over the middleware ceiling is refused 413 before the org context opens', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = await streamRequest(buildApp(), 'connections', huge);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(sent).toBeLessThanOrEqual(AGENT_WRAPPED_BODY_MAX_BYTES + 2 * chunk.byteLength);
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });

  it('(c) a declared Content-Length over the middleware ceiling is refused without reading the body', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await streamRequest(buildApp(), 'connections', stalledStream());
    // Sanity: without a declared length this stream would have hit the stall deadline.
    expect(res.status).toBe(408);
    const declared = await buildApp().request(`/api/v1/agents/${AGENT}/connections`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json', 'content-length': String(AGENT_WRAPPED_BODY_MAX_BYTES + 1) },
      body: stalledStream(),
      duplex: 'half',
    } as RequestInit);
    expect(declared.status).toBe(413);
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });

  it('a body that ends short of its declared Content-Length is refused, never handed on as complete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await buildApp().request(`/api/v1/agents/${AGENT}/connections`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json', 'content-length': '100' },
      body: delayedStream(['{"connections":[]}'], 1),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Failed to decode request body' });
    expect(withDbAccessContext).not.toHaveBeenCalled();
    expect(handled).not.toHaveBeenCalled();
    const line = warn.mock.calls.map((args) => String(args[0])).find((m) => m.includes('[agentAuth] request body'));
    expect(line).toContain('received 18 of 100 declared bytes');
  });

  it('(d) a self-managed route (heartbeat) is not buffered: its handler answers while the body is still stalled', async () => {
    const res = await streamRequest(buildApp(), 'heartbeat', stalledStream(['{"status":']), 'POST');
    expect(res.status).toBe(200);
    expect(handled).toHaveBeenCalledWith('heartbeat');
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });

  it('(d) a storage-session path is not buffered either', async () => {
    const res = await streamRequest(
      buildApp(),
      'storage-sessions/0b6f0c7e-3d2a-4f5b-9e1c-8a7d6c5b4a39/objects:resolve',
      stalledStream(['{']),
      'POST',
    );
    expect(res.status).toBe(200);
  });

  it('(d) a GET is never buffered and still gets the org context', async () => {
    const res = await buildApp().request(`/api/v1/agents/${AGENT}/config`, { headers: auth });
    expect(res.status).toBe(200);
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('(e) the org context opens only after the last body byte has arrived', async () => {
    // Generous stall window: this asserts ordering, not the deadline.
    process.env.AGENT_BODY_RECEIVE_TIMEOUT_MS = '2000';
    const res = await streamRequest(
      buildApp(),
      'connections',
      delayedStream(['{"connections":', '[{"port":1}]}'], 20),
    );
    expect(res.status).toBe(200);
    expect(events.log).toEqual(['body-done', 'context-opened', 'handler']);
  });

  it('a client that aborts mid-body gets the decode error, is logged with heldMs=0, and opens no context', async () => {
    const before = await rejectedCount('aborted', '/api/v1/agents/:id/connections');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let first = true;
    const aborting = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(encoder.encode('{"connections":'));
          return;
        }
        controller.error(new Error('aborted'));
      },
    });
    const res = await streamRequest(buildApp(), 'connections', aborting);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Failed to decode request body' });
    expect(withDbAccessContext).not.toHaveBeenCalled();
    expect(await rejectedCount('aborted', '/api/v1/agents/:id/connections')).toBe(before + 1);
    const line = warn.mock.calls.map((args) => String(args[0])).find((m) => m.includes('[agentAuth] request body'));
    expect(line).toContain('reason=aborted');
    expect(line).toContain('heldMs=0');
    expect(line).toContain('receivedBytes=15');
  });
});

/**
 * The incident shape over a REAL socket through @hono/node-server (the adapter
 * production runs): headers with a Content-Length, part of the body, then
 * silence. Proves the `c.req.raw` swap works on the adapter's lightweight
 * Request, and that the refusal is actually written back to a client whose
 * body never finished.
 */
describe('agentAuthMiddleware — stalled upload over a real node-server socket (#8839)', () => {
  let server: ServerType;
  let port: number;

  beforeEach(async () => {
    events.log = [];
    handled.mockClear();
    vi.mocked(withDbAccessContext).mockClear();
    redisHolder.current = new SortedSetRedisFake();
    mockDeviceLookup();
    process.env.AGENT_BODY_RECEIVE_TIMEOUT_MS = '80';
    await new Promise<void>((resolve) => {
      server = serve({ fetch: buildApp().fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    delete process.env.AGENT_BODY_RECEIVE_TIMEOUT_MS;
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function rawExchange(head: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        response += chunk;
      });
      // Backstop only: every exchange below ends with the server closing.
      const backstop = setTimeout(() => socket.destroy(), 3_000);
      socket.on('close', () => {
        clearTimeout(backstop);
        resolve(response);
      });
      socket.on('error', (err) => (response ? undefined : reject(err)));
      socket.write(head + body);
      if (halfClose) socket.end();
    });
  }

  let halfClose = false;

  function head(contentLength: number, extra: string[] = []): string {
    return [
      `PUT /api/v1/agents/${AGENT}/connections HTTP/1.1`,
      'Host: localhost',
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      `Content-Length: ${contentLength}`,
      ...extra,
      '',
      '',
    ].join('\r\n');
  }

  it('answers 408 to a body that stops arriving, without opening the org context', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await rawExchange(head(500), '{"connections":[');
    expect(response.startsWith('HTTP/1.1 408')).toBe(true);
    expect(response.toLowerCase()).toContain('connection: close');
    expect(response).toContain('Request body not received in time');
    expect(withDbAccessContext).not.toHaveBeenCalled();
    expect(handled).not.toHaveBeenCalled();
  });

  it('a complete body is buffered and validated normally', async () => {
    const body = JSON.stringify({ connections: [{ port: 3389 }] });
    const response = await rawExchange(head(Buffer.byteLength(body), ['Connection: close']), body);
    expect(response.startsWith('HTTP/1.1 200')).toBe(true);
    expect(handled).toHaveBeenCalledWith({ connections: [{ port: 3389 }] });
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('a client that sends part of its body and then closes never reaches the handler or the org context', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    halfClose = true;
    try {
      await rawExchange(head(500), '{"connections":[');
    } finally {
      halfClose = false;
    }
    // Give the server a beat to observe the close.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handled).not.toHaveBeenCalled();
    expect(withDbAccessContext).not.toHaveBeenCalled();
  });
});

describe('agent body-buffer constants', () => {
  it('defaults the stall deadline to 15 s and the total deadline to 60 s', () => {
    expect(AGENT_BODY_RECEIVE_TIMEOUT_MS).toBe(15_000);
    expect(AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS).toBe(60_000);
  });

  it('the ceiling admits every body the global gate admits on a wrapped agent path', () => {
    const wrappedAgentPaths = [
      '/api/v1/agents/a/commands/c/result',
      '/api/v1/agents/a/hardware',
      '/api/v1/agents/a/software',
      '/api/v1/agents/a/disks',
      '/api/v1/agents/a/network',
      '/api/v1/agents/a/connections',
      '/api/v1/agents/a/hardware-health',
      '/api/v1/agents/a/time-status',
      '/api/v1/agents/a/workloads',
      '/api/v1/agents/a/logs',
      '/api/v1/agents/a/security/status',
    ];
    for (const path of wrappedAgentPaths) {
      expect(AGENT_WRAPPED_BODY_MAX_BYTES).toBeGreaterThanOrEqual(bodyLimitForPath(path).maxSize);
    }
  });
});
