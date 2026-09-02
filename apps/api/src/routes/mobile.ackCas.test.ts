import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * POST /mobile/alerts/:id/acknowledge is a compare-and-swap (#4101).
 *
 * The twin of routes/alerts/alerts.ts's acknowledge handler, and it carried the
 * same check-then-act defect plus one of its own: it never looked at the UPDATE's
 * `RETURNING` at all (`updated?.id ?? alertId`), so a write that matched zero rows
 * still published `alert.acknowledged`, still emitted ML feedback, still wrote an
 * audit entry and still answered 200 — with a `null` body. Under `breeze_app` RLS a
 * zero-row write raises no error, so that fallback turned both a lost race and a
 * tenancy mismatch into a silent success.
 *
 * See alerts.ackSuppressCas.test.ts for why the predicate is asserted as COMPILED
 * SQL rather than by column name.
 */
const { dbMock, updateWheres, updateReturns, selectReturns, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];
  const selectReturns: unknown[][] = [];
  const alertRow = {
    id: '44444444-4444-4444-8444-444444444444',
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
    // mobile.ts keeps its OWN `getAlertWithOrgCheck`, so the pre-read is driven
    // through this queue rather than by mocking a helper module.
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
  setCooldown: vi.fn(),
  markConfigPolicyRuleCooldown: vi.fn(),
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

const ACK_CAS_LOST =
  'Alert is no longer acknowledgeable — its status is no longer active.';

const acknowledgeRequest = () =>
  app.request(`/mobile/alerts/${alertRow.id}/acknowledge`, { method: 'POST' });

beforeEach(() => {
  updateWheres.length = 0;
  updateReturns.length = 0;
  selectReturns.length = 0;
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
  emitAlertStateFeedback.mockResolvedValue(undefined);
  // The pre-read always sees an active alert; the race happens after it.
  selectReturns.push([{ ...alertRow, status: 'active' }]);
});

describe('POST /mobile/alerts/:id/acknowledge — the losing caller', () => {
  it('answers 409 and fans nothing out', async () => {
    updateReturns.push([]); // CAS matched nothing

    const res = await acknowledgeRequest();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: ACK_CAS_LOST });
    expect(publishEvent).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('POST /mobile/alerts/:id/acknowledge — the winning caller', () => {
  it('answers 200 with the updated row and publishes exactly once', async () => {
    updateReturns.push([{ ...alertRow, status: 'acknowledged' }]);

    const res = await acknowledgeRequest();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: alertRow.id, status: 'acknowledged' });
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.acknowledged');
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
  });

  it('gives an already-acknowledged alert the SAME 409 the CAS loser gets', async () => {
    selectReturns[0] = [{ ...alertRow, status: 'acknowledged' }];

    const res = await acknowledgeRequest();

    expect(res.status).toBe(409);
    expect(updateWheres).toHaveLength(0);
  });

  it('keeps a resolved alert a 400', async () => {
    selectReturns[0] = [{ ...alertRow, status: 'resolved' }];

    const res = await acknowledgeRequest();

    expect(res.status).toBe(400);
  });
});

describe('POST /mobile/alerts/:id/acknowledge — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND acknowledgeable status', async () => {
    updateReturns.push([{ ...alertRow, status: 'acknowledged' }]);

    await acknowledgeRequest();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2))');
    expect(params).toEqual([alertRow.id, 'active']);
  });
});
