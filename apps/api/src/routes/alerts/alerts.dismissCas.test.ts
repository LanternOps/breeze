import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * POST /alerts/:id/dismiss is a compare-and-swap (#4293) — the last single-alert
 * transition to become one, after resolve (#4094/#4099) and acknowledge/suppress
 * (#4101/#4288).
 *
 * The damage a lost race does here is narrower than the acknowledge case and is
 * NOT "an alert gets reopened": dismiss is deliberately legal from every other
 * status, so a dismiss landing on a just-resolved alert is the intended outcome,
 * not a bug. What the unguarded write clobbered is PROVENANCE. Two techs dismiss
 * the same alert; both id-only UPDATEs match, `dismissedAt`/`dismissedBy` end up
 * describing whichever write landed second, and BOTH callers get a 200, an ML
 * feedback emit and an audit row claiming they performed the transition. For the
 * terminal "make this go away for good" action, "who dismissed this, and when" is
 * the field most likely to be asked about later.
 *
 * Two kinds of assertion here, deliberately (see alerts.ackSuppressCas.test.ts):
 *
 *  - BEHAVIOUR — an empty `RETURNING` (exactly what Postgres gives a caller whose
 *    CAS matched nothing) must produce a 409 and NO fan-out.
 *  - COMPILED SQL — the predicate the handler actually passed to `.where()`,
 *    compiled through `PgDialect`. drizzle-orm and ../../db/schema are REAL in this
 *    file for that reason: a mocked-drizzle `where` assertion can only substring-
 *    match column NAMES, which cannot tell `and` from `or` and cannot see the
 *    status list gaining `dismissed` — which would make the CAS a no-op and
 *    restore the exact bug this closes.
 */
const { dbMock, updateWheres, updateReturns, selectRows, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];
  const selectRows: unknown[][] = [];
  const alertRow = {
    id: '44444444-4444-4444-8444-444444444444',
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
      set: () => ({
        where: (predicate: unknown) => {
          updateWheres.push(predicate);
          return { returning: () => Promise.resolve(updateReturns.shift() ?? []) };
        },
      }),
    }),
  };
  return { dbMock, updateWheres, updateReturns, selectRows, alertRow };
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
  markConfigPolicyRuleCooldown: vi.fn(),
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
// alerts.ackSuppressCas.test.ts; this suite does not exercise verdicts.
vi.mock('../../services/aiAgents/alertVerdicts', () => ({
  latestVerdictsForAlerts: vi.fn(async () => new Map()),
  projectAlertAiVerdictSummary: vi.fn(),
}));

import { alertsRoutes } from './alerts';
import { ALERT_DISMISS_CAS_LOST_MESSAGE } from '../../services/alertService';

const app = new Hono().route('/alerts', alertsRoutes);
const dialect = new PgDialect();

const dismissRequest = () => app.request(`/alerts/${alertRow.id}/dismiss`, { method: 'POST' });

beforeEach(() => {
  updateWheres.length = 0;
  updateReturns.length = 0;
  selectRows.length = 0;
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
  emitAlertStateFeedback.mockResolvedValue(undefined);
  // The pre-read always sees an actionable alert; the race happens after it.
  getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'active' });
});

describe('POST /alerts/:id/dismiss — the losing caller', () => {
  it('answers 409, not the old 500', async () => {
    updateReturns.push([]); // CAS matched nothing: another dismissal got there first

    const res = await dismissRequest();

    // Before the CAS this branch was unreachable (an id-only UPDATE always matched),
    // so it was written as a 500 "Failed to dismiss alert" — a server-fault code for
    // what is in fact a client-visible conflict. Now that the predicate can lose, the
    // outcome is a race, and it must read like the sibling transitions' race.
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: ALERT_DISMISS_CAS_LOST_MESSAGE });
  });

  it('emits no ML feedback and writes no audit for a dismissal it did not perform', async () => {
    updateReturns.push([]);

    await dismissRequest();

    // The whole point of the CAS. Before it, the loser's write silently overwrote
    // dismissedAt/dismissedBy and the loser still emitted feedback and an audit row
    // claiming the transition — two audit rows for one dismissal, the second naming
    // the wrong actor.
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('POST /alerts/:id/dismiss — the winning caller', () => {
  it('answers 200 and records the dismissal exactly once', async () => {
    updateReturns.push([{ ...alertRow, status: 'dismissed' }]);

    const res = await dismissRequest();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: alertRow.id, status: 'dismissed' });
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    // Dismiss deliberately publishes no event-bus event — nothing should notify or
    // escalate off a dismissal. Asserted so the CAS work cannot quietly add one.
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('still dismisses a RESOLVED alert — the transition dismiss exists for', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'resolved' });
    updateReturns.push([{ ...alertRow, status: 'dismissed' }]);

    const res = await dismissRequest();

    // `resolved` is terminal for every OTHER transition and is in dismiss's CAS set
    // on purpose: clearing an already-resolved alert for good is the documented
    // reason dismiss exists. A future tightening that drops `resolved` from the set
    // would break that workflow, and this is the test that says so.
    expect(res.status).toBe(200);
    expect(updateWheres).toHaveLength(1);
  });

  it('gives an already-dismissed alert the SAME 409 the CAS loser gets', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'dismissed' });

    const res = await dismissRequest();

    // Losing at the pre-read and losing at the CAS are the same real-world event —
    // somebody else dismissed first — so they must not return two different codes
    // purely on which side of the read the other write landed. #4099 made exactly
    // this change for resolve and #4288 for acknowledge; this endpoint's 400 was the
    // last outlier, and leaving it would have made the response code a coin-flip on
    // timing the moment the CAS below started returning 409.
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Alert is already dismissed' });
    // Short-circuited at the pre-read: no UPDATE was attempted at all.
    expect(updateWheres).toHaveLength(0);
  });
});

describe('POST /alerts/:id/dismiss — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND every non-dismissed status', async () => {
    updateReturns.push([{ ...alertRow, status: 'dismissed' }]);

    await dismissRequest();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    // Each plausible mutation changes this string or its params: `or` instead of
    // `and` would dismiss every non-dismissed alert in EVERY tenant from one
    // request; dropping the status list restores the unconditional write this issue
    // is about; and adding `dismissed` to the set makes the CAS match a row that is
    // already dismissed, i.e. a no-op guard that re-stamps someone else's
    // dismissedAt/dismissedBy.
    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4, $5))');
    expect(params).toEqual([alertRow.id, 'active', 'acknowledged', 'suppressed', 'resolved']);
  });
});
