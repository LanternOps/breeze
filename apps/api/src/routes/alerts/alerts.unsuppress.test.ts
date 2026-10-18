import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * POST /alerts/:id/unsuppress (#8966) — the server half of the toast "Undo" on
 * Mute. Compare-and-swap on status = 'suppressed' (same shape as #4101), restores
 * 'acknowledged' when the alert was acknowledged before it was muted, else 'active',
 * and clears suppressedUntil. drizzle-orm is REAL so the compiled predicate is
 * asserted, not just substring-matched.
 */
const { dbMock, updateSets, updateWheres, updateReturns, selectRows, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateSets: Record<string, unknown>[] = [];
  const updateReturns: unknown[][] = [];
  const selectRows: unknown[][] = [];
  const alertRow = {
    id: '33333333-3333-4333-8333-333333333333',
    orgId: 'org-1',
    deviceId: 'device-1',
    ruleId: null as string | null,
    configPolicyId: null as string | null,
    context: null as unknown,
    status: 'active',
    title: 'Disk almost full',
    triggeredAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const dbMock = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(selectRows.shift() ?? []) }) }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: (predicate: unknown) => {
          updateWheres.push(predicate);
          updateSets.push(payload);
          return { returning: () => Promise.resolve(updateReturns.shift() ?? []) };
        },
      }),
    }),
  };
  return { dbMock, updateSets, updateWheres, updateReturns, selectRows, alertRow };
});

const publishEvent = vi.fn((..._args: unknown[]) => Promise.resolve('evt'));
const emitAlertStateFeedback = vi.fn((..._args: unknown[]) => Promise.resolve());
const writeRouteAudit = vi.fn();
const getAlertWithOrgCheck = vi.fn();

vi.mock('../../db', () => ({
  db: dbMock,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', {
      scope: 'organization',
      user: { id: 'user-1', name: 'Tech One', email: 'tech@org.example' },
      partnerId: null,
      orgId: 'org-1',
      accessibleOrgIds: null,
      canAccessOrg: () => true,
    });
    await next();
  },
  requirePermission: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('permissions', { granted: new Set<string>() });
    await next();
  },
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  siteAccessCheck: () => () => true,
}));
vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: (...a: unknown[]) => writeRouteAudit(...a) }));
vi.mock('../../services/eventBus', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: (...a: unknown[]) => emitAlertStateFeedback(...a),
  emitCorrelationFeedback: vi.fn(),
}));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; },
}));
vi.mock('./helpers', () => ({
  getPagination: () => ({ page: 1, limit: 50, offset: 0 }),
  ensureOrgAccess: () => true,
  getAlertWithOrgCheck: (...args: unknown[]) => getAlertWithOrgCheck(...args),
  validateNotificationChannelConfig: vi.fn(),
}));
// Severs the aiVerdict transitive import chain — same reason as
// alerts.resolveCas.test.ts; this suite does not exercise verdicts.
vi.mock('../../services/aiAgents/alertVerdicts', () => ({
  latestVerdictsForAlerts: vi.fn(async () => new Map()),
  projectAlertAiVerdictSummary: vi.fn(),
}));

import { alertsRoutes } from './alerts';

const app = new Hono().route('/alerts', alertsRoutes);
const dialect = new PgDialect();

const UNSUPPRESS_CAS_LOST =
  'Alert is no longer suppressed — it was already restored, resolved or dismissed.';

const unsuppressRequest = (body?: Record<string, unknown>) =>
  app.request(`/alerts/${alertRow.id}/unsuppress`, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  updateWheres.length = 0;
  updateSets.length = 0;
  updateReturns.length = 0;
  selectRows.length = 0;
  vi.clearAllMocks();
  emitAlertStateFeedback.mockResolvedValue(undefined);
  getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'suppressed', acknowledgedAt: null });
});

describe('POST /alerts/:id/unsuppress', () => {
  it('restores a never-acknowledged alert to active and clears the mute', async () => {
    updateReturns.push([{ ...alertRow, status: 'active' }]);

    const res = await unsuppressRequest();

    expect(res.status).toBe(200);
    expect(updateSets[0]).toEqual({ status: 'active', suppressedUntil: null });
    await expect(res.json()).resolves.toMatchObject({ id: alertRow.id, status: 'active' });
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit.mock.calls[0]?.[1]).toMatchObject({ action: 'alert.unsuppress' });
  });

  it('restores a previously acknowledged alert to acknowledged', async () => {
    getAlertWithOrgCheck.mockResolvedValue({
      ...alertRow,
      status: 'suppressed',
      acknowledgedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    updateReturns.push([{ ...alertRow, status: 'acknowledged' }]);

    const res = await unsuppressRequest();

    expect(res.status).toBe(200);
    expect(updateSets[0]).toEqual({ status: 'acknowledged', suppressedUntil: null });
    await expect(res.json()).resolves.toMatchObject({ status: 'acknowledged' });
  });

  it('honours the caller-supplied pre-mute status over acknowledgedAt (expiry-reaper case)', async () => {
    getAlertWithOrgCheck.mockResolvedValue({
      ...alertRow,
      status: 'suppressed',
      acknowledgedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    updateReturns.push([{ ...alertRow, status: 'active' }]);

    const res = await unsuppressRequest({ restoreStatus: 'active' });

    expect(res.status).toBe(200);
    expect(updateSets[0]).toEqual({ status: 'active', suppressedUntil: null });
  });

  it('rejects a restoreStatus outside active/acknowledged', async () => {
    const res = await unsuppressRequest({ restoreStatus: 'resolved' });
    expect(res.status).toBe(400);
    expect(updateWheres).toHaveLength(0);
  });

  it('404s an alert the caller cannot see', async () => {
    getAlertWithOrgCheck.mockResolvedValue(null);
    const res = await unsuppressRequest();
    expect(res.status).toBe(404);
    expect(updateWheres).toHaveLength(0);
  });

  it('answers 409 without writing when the alert is not suppressed', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'resolved' });
    const res = await unsuppressRequest();
    expect(res.status).toBe(409);
    expect(updateWheres).toHaveLength(0);
  });

  it('answers 409 and fans nothing out when the CAS loses', async () => {
    updateReturns.push([]);
    const res = await unsuppressRequest();
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: UNSUPPRESS_CAS_LOST });
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('scopes the UPDATE by id AND status = suppressed (compiled SQL)', async () => {
    updateReturns.push([{ ...alertRow, status: 'active' }]);
    await unsuppressRequest();
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);
    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2))');
    expect(params).toEqual([alertRow.id, 'suppressed']);
  });
});
