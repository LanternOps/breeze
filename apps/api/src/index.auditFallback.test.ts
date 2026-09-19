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
vi.mock('./db/schema', () => ({ auditLogs: {} }));
vi.mock('./services/sentry', () => ({ captureException: vi.fn() }));

import * as auditService from './services/auditService';
import { writeAuditEvent, writeRouteAudit } from './services/auditEvents';
import { writeContactAudit } from './services/contacts/audit';

const orgId = '123e4567-e89b-42d3-a456-426614174000';
const actorId = '123e4567-e89b-42d3-a456-426614174001';
// Execute the actual mounted callback without importing index.ts, which boots
// servers and workers. Only routing/tenant lookup helpers are stubbed here.
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const methodAt = source.indexOf('  const method = c.req.method.toUpperCase();', source.indexOf('// Generic partner status guard'));
const start = source.lastIndexOf("api.use('*', ", methodAt) + "api.use('*', ".length;
const end = source.indexOf('\n});', methodAt) + 2;
const middleware = new Function('writeAuditEvent', 'runWithAuditRequestTracking',
  'isMutatingMethod', 'fallbackAuditEligible', 'resolveFallbackOrgId',
  'buildFallbackAction', 'getResourceTypeFromPath',
  transpile(`return ${source.slice(start, end)};`))(
  writeAuditEvent, auditService.runWithAuditRequestTracking,
  (method: string) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method),
  () => true, async () => orgId, () => 'route.generic', () => 'test',
) as MiddlewareHandler;

function appFor(action?: string) {
  const app = new Hono();
  app.use('*', middleware);
  app.post('/mutation', async (c) => {
    const event = { orgId, action: action!, resourceType: 'test' };
    if (action === 'ticket.create') {
      await auditService.createAuditLogAsync({ ...event, actorId, result: 'success' });
    } else if (action === 'contact.create') {
      writeContactAudit(c, { orgId, action, contactId: actorId });
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
