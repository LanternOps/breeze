import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * "Keep at <site>" (topology site location W3, #7887; spec S§11): PUT/DELETE
 * /devices/:id/site-assignment-confirmation. Records or clears devices.site_assignment_confirmed_at and audits the
 * actor; it never writes site_id and never moves anything.
 */

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), execute: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

const middleware = vi.hoisted(() => ({ scopes: [] as string[][], permissions: [] as string[][], mfa: 0 }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => { middleware.scopes.push(scopes); return async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'tech@harbor-dental.example', name: 'Test User' },
      scope: 'organization', orgId: 'org-123', partnerId: null, accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123', orgCondition: () => undefined, token: { mfa: true },
    });
    return next();
  }; }),
  requirePermission: vi.fn((resource: string, action: string) => { middleware.permissions.push([resource, action]); return async (c: any, next: any) => {
    if (c.req.header('x-deny') === 'devices:write') return c.json({ error: 'Permission denied' }, 403);
    const list = c.req.header('x-restrict-site-list');
    c.set('permissions', {
      permissions: [{ resource, action }], partnerId: null, orgId: 'org-123', roleId: 'role-123', scope: 'organization',
      ...(list ? { allowedSiteIds: list.split(',') } : {}),
    });
    return next();
  }; }),
  requireMfa: vi.fn(() => { middleware.mfa += 1; return async (_c: any, next: any) => next(); }),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { siteAssignmentConfirmationRoutes } from './siteAssignmentConfirmation';
import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SITE_A = '77777777-7777-4777-8777-777777777777';
const SITE_B = '88888888-8888-4888-8888-888888888888';
const device = { id: DEVICE_ID, orgId: 'org-123', siteId: SITE_A, hostname: 'DESKTOP-HD7K2QF', displayName: null };
const dialect = new PgDialect();

function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockImplementation((() => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}
let sets: Record<string, unknown>[];
let wheres: unknown[];
let returning: unknown[];
function rigUpdate() {
  sets = []; wheres = [];
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockImplementation((value: Record<string, unknown>) => {
      sets.push(value);
      return { where: vi.fn().mockImplementation((where: unknown) => { wheres.push(where); return { returning: vi.fn().mockResolvedValue(returning) }; }) };
    }),
  } as never);
}

const app = new Hono();
app.route('/devices', siteAssignmentConfirmationRoutes);
const call = (method: 'PUT' | 'DELETE', headers: Record<string, string> = {}) =>
  app.request(`/devices/${DEVICE_ID}/site-assignment-confirmation`, { method, headers: { Authorization: 'Bearer t', ...headers } });

beforeEach(() => {
  vi.clearAllMocks();
  queueSelect([device]);
  returning = [{ confirmedAt: new Date('2026-10-02T09:30:00Z') }];
  rigUpdate();
});

describe('site-assignment confirmation routes', () => {
  it('is gated by organization/partner/system scope, devices:write and MFA on both verbs', () => {
    expect(middleware.scopes).toEqual([['organization', 'partner', 'system'], ['organization', 'partner', 'system']]);
    expect(middleware.permissions).toEqual([['devices', 'write'], ['devices', 'write']]);
    expect(middleware.mfa).toBe(2);
  });

  it('PUT sets confirmedAt and audits the actor; it writes only the confirmation, guarded on the current site', async () => {
    const res = await call('PUT');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmedAt: '2026-10-02T09:30:00.000Z' });
    expect(Object.keys(sets[0]!)).toEqual(['siteAssignmentConfirmedAt']);
    expect(dialect.sqlToQuery(wheres[0] as never).sql).toMatch(/"site_id" = \$\d/);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-123', action: 'device.site_assignment_confirmed', resourceType: 'device', resourceId: DEVICE_ID, details: { siteId: SITE_A },
    }));
  });

  it('marks the org presence dirty on both verbs so the evaluator re-runs soon (suggestion back after "Turn on")', async () => {
    await call('PUT');
    await call('DELETE');
    const dirty = vi.mocked(db.execute).mock.calls.map(([q]) => dialect.sqlToQuery(q as never).sql).filter((t) => t.includes('topology_org_presence_state'));
    expect(dirty).toHaveLength(2);
    expect(dirty[0]).toMatch(/dirty_seq = dirty_seq \+ 1/);
  });

  it('DELETE clears it ("Turn on") and audits', async () => {
    returning = [{ confirmedAt: null }];
    const res = await call('DELETE');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmedAt: null });
    expect(sets[0]).toEqual({ siteAssignmentConfirmedAt: null });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.site_assignment_unconfirmed', details: { siteId: SITE_A },
    }));
  });

  it('PUT is 403 for a user restricted away from the device site, 403 without devices:write', async () => {
    const restricted = await call('PUT', { 'x-restrict-site-list': SITE_B });
    expect(restricted.status).toBe(403);
    expect(JSON.stringify(await restricted.json())).not.toContain(SITE_A);
    expect((await call('PUT', { 'x-deny': 'devices:write' })).status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('404 for an unknown device; 409 device_site_changed when the device moved after the check', async () => {
    queueSelect([]);
    expect((await call('PUT')).status).toBe(404);
    queueSelect([device]);
    returning = [];
    const moved = await call('PUT');
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: 'device_site_changed' });
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
