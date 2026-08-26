import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * POST /alerts/:id/resolve is a compare-and-swap (#4094).
 *
 * It used to read the alert's status and then UPDATE by id unconditionally —
 * textbook check-then-act. Two techs resolving the same alert within the same
 * second both "won": both stamped the row, both published `alert.resolved`
 * (cancelling pending escalations twice and handing the `'*'` automation
 * subscriber the same event twice), and both wrote a cooldown.
 *
 * Two kinds of assertion here, deliberately:
 *
 *  - BEHAVIOUR — an empty `RETURNING` (exactly what Postgres gives a caller whose
 *    CAS matched nothing) must produce a 409 and NO fan-out.
 *  - COMPILED SQL — the predicate the handler actually passed to `.where()`,
 *    compiled through `PgDialect`. drizzle-orm and ../../db/schema are REAL in this
 *    file for that reason: a mocked-drizzle `where` assertion can only substring-
 *    match column NAMES, which cannot tell `and` from `or` and cannot see the
 *    status list gaining a terminal value. Both of those mutations were verified
 *    to pass green against exactly that style of test (main 8763a3239).
 */
const { dbMock, updateWheres, updateReturns, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];
  const alertRow = {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    deviceId: 'device-1',
    ruleId: null as string | null,
    configPolicyId: null as string | null,
    context: null as unknown,
    status: 'active',
    title: 'Disk almost full',
  };
  const dbMock = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
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
  return { dbMock, updateWheres, updateReturns, alertRow };
});

const publishEvent = vi.fn((..._args: unknown[]) => Promise.resolve('evt'));
const emitAlertStateFeedback = vi.fn((..._args: unknown[]) => Promise.resolve());
const writeRouteAudit = vi.fn();
const setCooldown = vi.fn((..._args: unknown[]) => Promise.resolve());
const markConfigPolicyRuleCooldown = vi.fn((..._args: unknown[]) => Promise.resolve());
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
  setCooldown: (...args: unknown[]) => setCooldown(...args),
  markConfigPolicyRuleCooldown: (...args: unknown[]) => markConfigPolicyRuleCooldown(...args),
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

import { alertsRoutes } from './alerts';

const app = new Hono().route('/alerts', alertsRoutes);
const dialect = new PgDialect();

const resolveRequest = () =>
  app.request(`/alerts/${alertRow.id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'cleared by hand' }),
  });

beforeEach(() => {
  updateWheres.length = 0;
  updateReturns.length = 0;
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
  emitAlertStateFeedback.mockResolvedValue(undefined);
  setCooldown.mockResolvedValue(undefined);
  markConfigPolicyRuleCooldown.mockResolvedValue(undefined);
  // The pre-read always sees a resolvable alert; the race happens after it.
  getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'active' });
});

describe('POST /alerts/:id/resolve — the losing caller', () => {
  it('answers 409 and does not report a resolution it did not perform', async () => {
    updateReturns.push([]); // CAS matched nothing: another request got there first

    const res = await resolveRequest();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Alert was already resolved or dismissed by another request',
    });
  });

  it('publishes no alert.resolved event', async () => {
    updateReturns.push([]);

    await resolveRequest();

    // The whole point of the CAS: escalation cancellation and the '*' automation
    // subscriber must see one event per real transition, not one per request.
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('writes no cooldown, no ML feedback and no audit entry', async () => {
    updateReturns.push([]);

    await resolveRequest();

    expect(setCooldown).not.toHaveBeenCalled();
    expect(markConfigPolicyRuleCooldown).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('POST /alerts/:id/resolve — the winning caller', () => {
  it('answers 200 with the updated row and publishes exactly once', async () => {
    updateReturns.push([{ ...alertRow, status: 'resolved' }]);

    const res = await resolveRequest();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: alertRow.id, status: 'resolved' });
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.resolved');
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
  });

  it('still short-circuits an alert the pre-read already saw as resolved', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'resolved' });

    const res = await resolveRequest();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Alert is already resolved' });
    // Same outcome as losing the CAS, so it must carry the same status code — a
    // 400 here and a 409 there would make one user action return two codes
    // depending purely on timing.
    expect(updateWheres).toHaveLength(0);
  });

  it('keeps dismissed a 400, not a race', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'dismissed' });

    const res = await resolveRequest();

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Cannot resolve a dismissed alert' });
  });
});

describe('POST /alerts/:id/resolve — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND resolvable status', async () => {
    updateReturns.push([{ ...alertRow, status: 'resolved' }]);

    await resolveRequest();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    // `or` instead of `and` would stamp every active/acknowledged/suppressed alert
    // in EVERY tenant resolved from one request; dropping the status list makes the
    // write unconditional again; admitting 'resolved' or 'dismissed' makes the CAS
    // a no-op. Each of those changes this string or its params.
    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual([alertRow.id, 'active', 'acknowledged', 'suppressed']);
  });
});
