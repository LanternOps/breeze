import { readFileSync } from 'node:fs';
import { Hono, type MiddlewareHandler } from 'hono';
import { transpile } from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { values } = vi.hoisted(() => ({ values: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./db', () => ({
  db: { insert: () => ({ values }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./db/schema', () => ({
  auditLogs: {},
  // Tables the org resolver may look up; no test here reaches a lookup.
  contracts: {}, deviceGroups: {}, devices: {}, invoices: {}, quotes: {}, securityThreats: {}, tickets: {},
}));
vi.mock('./services/sentry', () => ({ captureException: vi.fn() }));
// The real org resolver is exercised below; only its DB-context wrapper is
// stubbed (path/query org ids need no lookup).
vi.mock('./middleware/auth', () => ({
  withAuthDbAccessContext: (_auth: unknown, fn: () => unknown) => fn(),
}));

import * as auditService from './services/auditService';
import { writeAuditEvent, writeRouteAudit } from './services/auditEvents';
import { writeContactAudit } from './services/contacts/audit';
import { resolveFallbackOrgId } from './services/auditFallbackOrg';

const orgId = '123e4567-e89b-42d3-a456-426614174000';
const actorId = '123e4567-e89b-42d3-a456-426614174001';
// Execute the actual mounted callback without importing index.ts, which boots
// servers and workers. Only routing/tenant lookup helpers are stubbed here.
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const methodAt = source.indexOf('  const method = c.req.method.toUpperCase();', source.indexOf('// Generic partner status guard'));
const start = source.lastIndexOf("api.use('*', ", methodAt) + "api.use('*', ".length;
const end = source.indexOf('\n});', methodAt) + 2;
const buildMiddleware = (resolveOrg: (c: unknown, path: string) => Promise<string | null>) => new Function(
  'writeAuditEvent', 'runWithAuditRequestTracking',
  'isMutatingMethod', 'fallbackAuditEligible', 'resolveFallbackOrgId',
  'buildFallbackAction', 'getResourceTypeFromPath',
  transpile(`return ${source.slice(start, end)};`))(
  writeAuditEvent, auditService.runWithAuditRequestTracking,
  (method: string) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method),
  () => true, resolveOrg, () => 'route.generic', () => 'test',
) as MiddlewareHandler;
const middleware = buildMiddleware(async () => orgId);

function appFor(action?: string) {
  const app = new Hono();
  app.use('*', middleware);
  app.post('/mutation', async (c) => {
    const event = { orgId, action: action!, resourceType: 'test' };
    if (action === 'ticket.create') {
      await auditService.createAuditLogAsync({ ...event, actorId, result: 'success' });
    } else if (action === 'contact.create') {
      writeContactAudit(c, { orgId, action, contactId: actorId });
    } else if (action === 'direct.insert') {
      // A handler that inserts into audit_logs itself (in-transaction).
      auditService.markRequestAuditWritten();
    } else if (action) {
      writeRouteAudit(c, event);
    }
    return c.json({ success: true }, 201);
  });
  return app;
}

beforeEach(() => values.mockReset().mockResolvedValue(undefined));

describe('generic audit fallback', () => {
  it.each(['site.create', 'contact.create', 'device.update', 'ticket.create'])(
    'writes only the semantic row for %s', async (action) => {
      const response = await appFor(action).request('/mutation', { method: 'POST' });
      expect(response.status).toBe(201);
      expect(values).toHaveBeenCalledTimes(1);
      expect(values).toHaveBeenCalledWith(expect.objectContaining({ action, orgId }));
    },
  );

  it('writes no fallback row when the handler inserted its own audit row directly', async () => {
    const response = await appFor('direct.insert').request('/mutation', { method: 'POST' });
    expect(response.status).toBe(201);
    expect(values).not.toHaveBeenCalled();
  });

  it('keeps the fallback for a request without a semantic audit', async () => {
    await appFor().request('/mutation', { method: 'POST' });
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      action: 'route.generic', details: expect.objectContaining({ fallback: true }),
    }));
  });

  it('isolates overlapping requests with and without semantic audits', async () => {
    await Promise.all([
      appFor('site.create').request('/mutation', { method: 'POST' }),
      appFor().request('/mutation', { method: 'POST' }),
    ]);
    expect(values.mock.calls.map(([row]) => row.action).sort()).toEqual(['route.generic', 'site.create']);
  });

  it('suppresses fallback while a fire-and-forget semantic write is pending', async () => {
    let finish!: () => void;
    values.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    try {
      await appFor('site.create').request('/mutation', { method: 'POST' });
      expect(values).toHaveBeenCalledTimes(1);
    } finally {
      finish();
    }
  });

  it('preserves multiple semantic events within a request', async () => {
    const written = await auditService.runWithAuditRequestTracking(async () => {
      for (const action of ['site.create', 'contact.create']) {
        await auditService.createAuditLogAsync({ orgId, actorId, action, resourceType: 'test', result: 'success' });
      }
    });
    expect(written).toBe(true);
    expect(values).toHaveBeenCalledTimes(2);
  });

  it('tracks successful awaited writes but does not claim failed awaited writes', async () => {
    const event = { orgId, actorId, action: 'site.create', resourceType: 'site', result: 'success' as const };
    expect(await auditService.runWithAuditRequestTracking(async () => {
      await auditService.createAuditLog(event);
    })).toBe(true);
    values.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await auditService.runWithAuditRequestTracking(async () => {
      await expect(auditService.createAuditLog(event)).rejects.toThrow('database unavailable');
    })).toBe(false);
  });
});

describe('generic audit fallback — org targeted by a partner-scope request', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const FOREIGN_ORG = '33333333-3333-4333-8333-333333333333';
  const PARTNER_ID = '44444444-4444-4444-8444-444444444444';
  const realMiddleware = buildMiddleware(resolveFallbackOrgId as (c: unknown, path: string) => Promise<string | null>);

  function partnerApp(accessibleOrgIds: string[]) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        scope: 'partner',
        orgId: null,
        partnerId: PARTNER_ID,
        accessibleOrgIds,
        canAccessOrg: (id: string) => accessibleOrgIds.includes(id),
        user: { id: actorId, email: 'tech@example.test' },
      } as never);
      await next();
    });
    app.use('*', realMiddleware);
    app.patch('/api/v1/orgs/:orgId/billing-settings', (c) => c.json({ data: {} }));
    app.post('/api/v1/scripts', (c) => c.json({ data: {} }, 201));
    app.post('/api/v1/partner/known-guests', (c) => c.json({ data: {} }, 201));
    app.post('/api/v1/catalog/denied', (c) => c.json({ error: 'forbidden' }, 403));
    app.post('*', (c) => c.json({ data: {} }, 201));
    return app;
  }

  it('records the row in the org named by the path for a multi-org partner caller', async () => {
    const res = await partnerApp([ORG_A, ORG_B]).request(`/api/v1/orgs/${ORG_B}/billing-settings`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_B,
      actorId,
      result: 'success',
      details: expect.objectContaining({ fallback: true, path: `/api/v1/orgs/${ORG_B}/billing-settings` }),
    }));
  });

  it('does not file a partner-wide write under the org the web client put in ?orgId=', async () => {
    // fetchWithAuth appends the org switcher's current org to most requests;
    // it is UI state, not the org this partner-level write acted on.
    const res = await partnerApp([ORG_A, ORG_B]).request(`/api/v1/partner/known-guests?orgId=${ORG_A}`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).not.toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });

  it.each([
    [`/api/v1/orgs/${FOREIGN_ORG}/billing-settings`, 'PATCH'],
    [`/api/v1/orgs/${FOREIGN_ORG}/billing-settings?orgId=${ORG_A}`, 'PATCH'],
  ])('never files %s under an org outside the caller\'s access', async (url, method) => {
    await partnerApp([ORG_A, ORG_B]).request(url, { method });
    for (const [row] of values.mock.calls) {
      expect(row.orgId ?? null).toBeNull();
    }
  });

  // Partner-level writes (catalog, distributors, price books, UniFi, known
  // guests, work types, deliverable/checklist templates, third-party catalog)
  // have no org of their own. They are recorded as partner-level rows
  // (org_id NULL) attributed to the caller's partner rather than dropped.
  it.each([
    '/api/v1/catalog/items',
    '/api/v1/catalog/distributors',
    '/api/v1/catalog/price-books',
    '/api/v1/unifi/connect',
    '/api/v1/partner/known-guests',
    '/api/v1/billing-profiles/work-types',
    '/api/v1/deliverable-templates',
    '/api/v1/ticket-checklist-templates',
    '/api/v1/third-party-catalog/items',
  ])('records a partner-level row for a multi-org partner caller on %s', async (url) => {
    const res = await partnerApp([ORG_A, ORG_B]).request(url, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledTimes(1);
    const [row] = values.mock.calls[0]!;
    expect(row.orgId ?? null).toBeNull();
    expect(row).toEqual(expect.objectContaining({
      actorId,
      actorType: 'user',
      result: 'success',
      details: expect.objectContaining({ fallback: true, path: url, partnerId: PARTNER_ID }),
    }));
  });

  it('records the partner-level row as denied when the write was refused', async () => {
    await partnerApp([ORG_A, ORG_B]).request('/api/v1/catalog/denied', { method: 'POST' });
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ result: 'denied' }));
  });

  it('still writes nothing for an unauthenticated request it cannot attribute', async () => {
    const app = new Hono();
    app.use('*', realMiddleware);
    app.post('/api/v1/catalog/items', (c) => c.json({ data: {} }, 201));
    await app.request('/api/v1/catalog/items', { method: 'POST' });
    expect(values).not.toHaveBeenCalled();
  });

  it('keeps writing a single-org partner caller\'s rows to that org', async () => {
    await partnerApp([ORG_A]).request('/api/v1/scripts', { method: 'POST' });
    expect(values).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });
});
