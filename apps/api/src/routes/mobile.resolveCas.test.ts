import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * POST /mobile/alerts/:id/resolve is a compare-and-swap (#4094).
 *
 * The twin of routes/alerts/alerts.ts's handler and it carried the same
 * check-then-act defect: read the status, then UPDATE by id unconditionally, then
 * publish. See alerts.resolveCas.test.ts for the full rationale and for why the
 * predicate is asserted as COMPILED SQL rather than by column name.
 */
const { dbMock, updateWheres, updateReturns, selectReturns, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];
  const selectReturns: unknown[][] = [];
  const alertRow = {
    id: '22222222-2222-4222-8222-222222222222',
    orgId: 'org-1',
    deviceId: 'device-1',
    ruleId: null as string | null,
    configPolicyId: null as string | null,
    context: null as unknown,
    status: 'active',
    title: 'Agent offline',
    triggeredAt: new Date('2026-08-29T10:00:00.000Z'),
  };
  const dbMock = {
    // mobile.ts keeps its OWN `getAlertWithOrgCheck` (it is not the shared
    // routes/alerts/helpers one), so the pre-read is driven through this queue
    // rather than by mocking a helper module.
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectReturns.shift() ?? []) }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (predicate: unknown) => {
          updateWheres.push(predicate);
          return { returning: () => Promise.resolve(updateReturns.shift() ?? []) };
        },
      }),
    }),
  };
  return { dbMock, updateWheres, updateReturns, selectReturns, alertRow };
});

const publishEvent = vi.fn((..._args: unknown[]) => Promise.resolve('evt'));
const emitAlertStateFeedback = vi.fn((..._args: unknown[]) => Promise.resolve());
const writeRouteAudit = vi.fn();
const setCooldown = vi.fn((..._args: unknown[]) => Promise.resolve());
const markConfigPolicyRuleCooldown = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../middleware/auth', () => ({
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
}));
vi.mock('../middleware/userRateLimit', () => ({ userRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../services/alertCooldown', () => ({
  setCooldown: (...args: unknown[]) => setCooldown(...args),
  markConfigPolicyRuleCooldown: (...args: unknown[]) => markConfigPolicyRuleCooldown(...args),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: (...a: unknown[]) => writeRouteAudit(...a) }));
vi.mock('../services/eventBus', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }));
vi.mock('../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: (...a: unknown[]) => emitAlertStateFeedback(...a),
}));
vi.mock('../services/wakeOnLan', () => ({ dispatchWake: vi.fn() }));
vi.mock('../services/scriptExecution', () => ({ executeScriptOnDevices: vi.fn() }));

import { mobileRoutes } from './mobile';

const app = new Hono().route('/mobile', mobileRoutes);
const dialect = new PgDialect();

const resolveRequest = () =>
  app.request(`/mobile/alerts/${alertRow.id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'cleared from the phone' }),
  });

beforeEach(() => {
  updateWheres.length = 0;
  updateReturns.length = 0;
  selectReturns.length = 0;
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
  emitAlertStateFeedback.mockResolvedValue(undefined);
  setCooldown.mockResolvedValue(undefined);
  markConfigPolicyRuleCooldown.mockResolvedValue(undefined);
  // The pre-read always sees a resolvable alert; the race happens after it.
  selectReturns.push([{ ...alertRow, status: 'active' }]);
});

describe('POST /mobile/alerts/:id/resolve — the losing caller', () => {
  it('answers 409 and fans nothing out', async () => {
    updateReturns.push([]); // CAS matched nothing

    const res = await resolveRequest();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Alert is no longer resolvable — it already reached a terminal status (resolved or dismissed).',
    });
    expect(publishEvent).not.toHaveBeenCalled();
    expect(setCooldown).not.toHaveBeenCalled();
    expect(markConfigPolicyRuleCooldown).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('POST /mobile/alerts/:id/resolve — the winning caller', () => {
  it('answers 200 and publishes exactly once', async () => {
    updateReturns.push([{ ...alertRow, status: 'resolved' }]);

    const res = await resolveRequest();

    expect(res.status).toBe(200);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.resolved');
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
  });

  it('returns the same 409 the CAS loser gets when the pre-read already sees resolved', async () => {
    selectReturns[0] = [{ ...alertRow, status: 'resolved' }];

    const res = await resolveRequest();

    expect(res.status).toBe(409);
    expect(updateWheres).toHaveLength(0);
  });

  it('keeps dismissed a 400', async () => {
    selectReturns[0] = [{ ...alertRow, status: 'dismissed' }];

    const res = await resolveRequest();

    expect(res.status).toBe(400);
  });
});

describe('POST /mobile/alerts/:id/resolve — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND resolvable status', async () => {
    updateReturns.push([{ ...alertRow, status: 'resolved' }]);

    await resolveRequest();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual([alertRow.id, 'active', 'acknowledged', 'suppressed']);
  });
});
