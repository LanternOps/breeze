import { describe, expect, it, vi } from 'vitest';
import type { M365SyncActionResponse } from '@breeze/shared/m365';
import { createExecutorApp } from './app';
import { createInFlightGate } from './inFlight';
import { startExecutorServer } from './index';
import { renderMetrics, resetMetrics } from './metrics';

describe('executor HTTP app', () => {
  it('authenticates the exact raw body before parsing JSON', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('unauthorized'));
    const completeConsent = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent,
      retest: vi.fn(),
      readAction: vi.fn(),
      syncAction: vi.fn(),
    });

    const response = await app.request('/v1/complete-consent', {
      method: 'POST',
      headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      body: '{not-json',
    });

    expect(response.status).toBe(401);
    expect(verify).toHaveBeenCalledOnce();
    expect(completeConsent).not.toHaveBeenCalled();
  });

  it('passes the exact UTF-8 bytes and fixed operation to auth before executing', async () => {
    const body = JSON.stringify({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
    });
    const verify = vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' });
    const retest = vi.fn().mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });
    const app = createExecutorApp({
      authenticator: { verify }, completeConsent: vi.fn(), retest, readAction: vi.fn(), syncAction: vi.fn(),
    });

    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith({
      authorization: 'Bearer token',
      operation: 'retest',
      rawBody: new TextEncoder().encode(body),
    });
    expect(retest).toHaveBeenCalledOnce();
  });

  it('bounds bodies before auth and exposes only the two POST operations', async () => {
    const verify = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      readAction: vi.fn(),
      syncAction: vi.fn(),
      maxBodyBytes: 8,
    });
    const oversized = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: '{"more":true}',
    });
    expect(oversized.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    expect((await app.request('/v1/retest')).status).toBe(404);
    expect((await app.request('/v1/arbitrary', { method: 'POST' })).status).toBe(404);
    expect(await (await app.request('/healthz')).json()).toEqual({ status: 'ok' });
  });

  it('sanitizes operation exceptions instead of classifying them as caller errors', async () => {
    const app = createExecutorApp({
      authenticator: { verify: vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' }) },
      completeConsent: vi.fn(),
      retest: vi.fn().mockRejectedValue(new Error('provider body with secret access-token')),
      readAction: vi.fn(),
      syncAction: vi.fn(),
    });
    const response = await app.request('/v1/retest', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
      }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('binds the server only to the configured private interface and supports shutdown', () => {
    const close = vi.fn();
    const serve = vi.fn().mockReturnValue({ close });
    const app = createExecutorApp({
      authenticator: { verify: vi.fn() },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      readAction: vi.fn(),
      syncAction: vi.fn(),
    });
    const server = startExecutorServer(app, { bindHost: '10.20.30.40', port: 8788 }, serve);
    expect(serve).toHaveBeenCalledWith({ fetch: app.fetch, hostname: '10.20.30.40', port: 8788 });
    server.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('serves POST /v1/read-action with the stubbed dependency result', async () => {
    const correlationId = '11111111-1111-4111-8111-111111111111';
    const verify = vi.fn().mockResolvedValue({ correlationId });
    const stubbedResult = { success: true, kind: 'resource', resource: { id: 'x' } };
    const readAction = vi.fn().mockResolvedValue(stubbedResult);
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      readAction,
      syncAction: vi.fn(),
    });

    const response = await app.request('/v1/read-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId,
        tenantId: '22222222-2222-4222-8222-222222222222',
        action: { type: 'm365.org.get' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stubbedResult);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operation: 'read-action' }));
    expect(readAction).toHaveBeenCalledOnce();
  });

  it('rejects a read-action body whose correlationId does not match the authenticated one', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' });
    const readAction = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      readAction,
      syncAction: vi.fn(),
    });

    const response = await app.request('/v1/read-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId: '99999999-9999-4999-8999-999999999999',
        tenantId: '22222222-2222-4222-8222-222222222222',
        action: { type: 'm365.org.get' },
      }),
    });

    expect(response.status).toBe(401);
    expect(readAction).not.toHaveBeenCalled();
  });

  it('rejects an invalid read-action body', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' });
    const readAction = vi.fn();
    const app = createExecutorApp({
      authenticator: { verify },
      completeConsent: vi.fn(),
      retest: vi.fn(),
      readAction,
      syncAction: vi.fn(),
    });

    const response = await app.request('/v1/read-action', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify({
        correlationId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'not-a-guid',
        action: { type: 'm365.org.get' },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(readAction).not.toHaveBeenCalled();
  });
});

const SYNC_BODY = JSON.stringify({
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  action: { type: 'm365.sync.skus' },
});
const READ_BODY = JSON.stringify({
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  action: { type: 'm365.org.get' },
});
const SYNC_ON_READ_BODY = JSON.stringify({
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  action: { type: 'm365.sync.users' },
});
const OK_SYNC: M365SyncActionResponse = {
  success: true, kind: 'sync', items: [], truncated: false,
  fetchedAt: '2026-09-08T00:00:00.000Z', sources: { subscribedSkus: 'ok' },
};
const authenticated = () => ({
  verify: vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' }),
});
const post = (app: ReturnType<typeof createExecutorApp>, path: string, body: string) => app.request(path, {
  method: 'POST',
  headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
  body,
});

describe('sync-action route', () => {
  it('binds the sync-action operation into the auth check', async () => {
    const verify = vi.fn().mockResolvedValue({ correlationId: '11111111-1111-4111-8111-111111111111' });
    const syncAction = vi.fn().mockResolvedValue(OK_SYNC);
    const app = createExecutorApp({
      authenticator: { verify }, completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(), syncAction,
    });
    const response = await post(app, '/v1/sync-action', SYNC_BODY);
    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith({
      authorization: 'Bearer token',
      operation: 'sync-action',
      rawBody: new TextEncoder().encode(SYNC_BODY),
    });
    expect(await response.json()).toEqual(OK_SYNC);
  });

  it('refuses a sync id on /v1/read-action and a read id on /v1/sync-action', async () => {
    const readAction = vi.fn();
    const syncAction = vi.fn();
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction, syncAction,
    });
    const refusedRead = await post(app, '/v1/read-action', SYNC_ON_READ_BODY);
    expect(refusedRead.status).toBe(400);
    expect(await refusedRead.json()).toMatchObject({ code: 'action_not_allowed' });
    expect(readAction).not.toHaveBeenCalled();

    const refusedSync = await post(app, '/v1/sync-action', READ_BODY);
    expect(refusedSync.status).toBe(400);
    expect(await refusedSync.json()).toMatchObject({ code: 'action_not_allowed' });
    expect(syncAction).not.toHaveBeenCalled();
  });

  it('returns 503 sync_capacity with Retry-After once the sync cap is full', async () => {
    resetMetrics();
    let release!: () => void;
    const syncAction = vi.fn(() => new Promise<typeof OK_SYNC>((resolve) => { release = () => resolve(OK_SYNC); }));
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(), syncAction,
      gate: createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 4 }),
    });
    const inflight = post(app, '/v1/sync-action', SYNC_BODY);
    const refused = await post(app, '/v1/sync-action', SYNC_BODY);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(await refused.json()).toEqual({
      error: 'sync_capacity', code: 'sync_capacity', retryAfterSeconds: 30,
    });
    expect(renderMetrics()).toContain('m365_sync_capacity_rejected_total{kind="sync"} 1');
    release();
    expect((await inflight).status).toBe(200);
  });

  it('reserves headroom: a full sync cap does not refuse an interactive call', async () => {
    let release!: () => void;
    const app = createExecutorApp({
      authenticator: authenticated(),
      completeConsent: vi.fn(), retest: vi.fn(),
      readAction: vi.fn().mockResolvedValue({ success: true, kind: 'resource', resource: {} }),
      syncAction: vi.fn(() => new Promise<typeof OK_SYNC>((resolve) => { release = () => resolve(OK_SYNC); })),
      gate: createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 4 }),
    });
    const held = post(app, '/v1/sync-action', SYNC_BODY);
    expect((await post(app, '/v1/sync-action', SYNC_BODY)).status).toBe(503);
    expect((await post(app, '/v1/read-action', READ_BODY)).status).toBe(200);
    release();
    await held;
  });

  it('refuses past the TOTAL cap even on the interactive route', async () => {
    let releases: Array<() => void> = [];
    const app = createExecutorApp({
      authenticator: authenticated(),
      completeConsent: vi.fn(), retest: vi.fn(),
      readAction: vi.fn(() => new Promise<{ success: true; kind: 'resource'; resource: Record<string, unknown> }>((resolve) => { releases.push(() => resolve({ success: true, kind: 'resource', resource: {} })); })),
      syncAction: vi.fn(),
      gate: createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 1 }),
    });
    const held = post(app, '/v1/read-action', READ_BODY);
    const refused = await post(app, '/v1/read-action', READ_BODY);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: 'capacity' });
    releases.forEach((fn) => fn());
    await held;
  });

  it('answers 504 when the operation outruns the route timeout, and frees the slot', async () => {
    const gate = createInFlightGate({ syncMaxInFlight: 1, maxInFlight: 4 });
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(),
      syncAction: () => new Promise(() => {}),   // never settles
      gate,
      syncTimeoutMs: 5,
    });
    const response = await post(app, '/v1/sync-action', SYNC_BODY);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: 'sync_timeout' });
    expect(gate.snapshot()).toEqual({ sync: 0, total: 0 });
  });

  it('serves the metrics registry unauthenticated on the private interface', async () => {
    const app = createExecutorApp({
      authenticator: { verify: vi.fn() }, completeConsent: vi.fn(), retest: vi.fn(),
      readAction: vi.fn(), syncAction: vi.fn(),
    });
    const response = await app.request('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('# TYPE m365_sync_actions_total counter');
  });

  it('rejects a malformed sync body before the operation runs', async () => {
    const syncAction = vi.fn();
    const app = createExecutorApp({
      authenticator: authenticated(), completeConsent: vi.fn(), retest: vi.fn(), readAction: vi.fn(), syncAction,
    });
    const response = await post(app, '/v1/sync-action', JSON.stringify({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      action: { type: 'm365.sync.skus', backfill: true },   // wrong branch option
    }));
    expect(response.status).toBe(400);
    expect(syncAction).not.toHaveBeenCalled();
  });
});
