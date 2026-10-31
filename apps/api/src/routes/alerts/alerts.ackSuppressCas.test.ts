import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * POST /alerts/:id/acknowledge and POST /alerts/:id/suppress are compare-and-swaps
 * (#4101), for the same reason POST /alerts/:id/resolve became one in #4094/#4099.
 *
 * Both used to read the alert's status and then UPDATE by id unconditionally —
 * textbook check-then-act. The damage is not merely a double-acknowledge: tech A
 * resolves (the resolve CAS wins, `alert.resolved` publishes, the escalation is
 * cancelled), tech B's stale list still shows the alert active and B clicks
 * Acknowledge. B's id-only UPDATE stamps `status='acknowledged'` over the
 * resolution, leaving a reopened alert that carries `resolvedAt`/`resolvedBy` and
 * whose escalation is already gone. Suppress has the identical shape.
 *
 * Two kinds of assertion here, deliberately (see alerts.resolveCas.test.ts):
 *
 *  - BEHAVIOUR — an empty `RETURNING` (exactly what Postgres gives a caller whose
 *    CAS matched nothing) must produce a 409 and NO fan-out.
 *  - COMPILED SQL — the predicate the handler actually passed to `.where()`,
 *    compiled through `PgDialect`. drizzle-orm and ../../db/schema are REAL in this
 *    file for that reason: a mocked-drizzle `where` assertion can only substring-
 *    match column NAMES, which cannot tell `and` from `or` and cannot see the
 *    status list gaining a status that makes the CAS a no-op.
 */
const { dbMock, updateWheres, updateReturns, selectRows, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
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
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectRows.shift() ?? []),
          // POST /alerts/bulk awaits the `.where()` directly (no `.limit()`).
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(selectRows.shift() ?? []).then(ok, bad),
        }),
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
// POST /alerts/bulk resolves permissions inside the handler (needs `action`).
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: async () => ({ granted: new Set(['alerts:write']) }),
    hasPermission: (perms: { granted?: Set<string> } | null, resource: string, action: string) =>
      perms?.granted?.has(`${resource}:${action}`) ?? false,
  };
});
vi.mock('../tickets/siteScope', () => ({
  filterAlertsBySiteScope: async (_auth: unknown, rows: unknown[]) => rows,
  deviceInSiteScope: async () => true,
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

const ACK_CAS_LOST =
  'Alert is no longer acknowledgeable — its status is no longer active.';
const SUPPRESS_CAS_LOST =
  'Alert is no longer suppressible — it already reached a terminal status (resolved or dismissed).';

const acknowledgeRequest = () =>
  app.request(`/alerts/${alertRow.id}/acknowledge`, { method: 'POST' });

const suppressUntil = new Date('2099-01-01T00:00:00.000Z').toISOString();
const suppressRequest = (body: Record<string, unknown> = { until: suppressUntil }) =>
  app.request(`/alerts/${alertRow.id}/suppress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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

describe('POST /alerts/:id/acknowledge — the losing caller', () => {
  it('answers 409 and does not report an acknowledgement it did not perform', async () => {
    updateReturns.push([]); // CAS matched nothing: another transition got there first

    const res = await acknowledgeRequest();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: ACK_CAS_LOST });
  });

  it('publishes no alert.acknowledged event, emits no ML feedback and writes no audit', async () => {
    updateReturns.push([]);

    await acknowledgeRequest();

    // The whole point of the CAS. Before it, a stale client acking an alert that
    // was resolved a moment ago both clobbered the resolution AND published
    // `alert.acknowledged` for a transition that never legitimately happened,
    // feeding the ML feedback loop a phantom acknowledgement.
    expect(publishEvent).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('POST /alerts/:id/acknowledge — the winning caller', () => {
  it('answers 200 and publishes exactly once', async () => {
    updateReturns.push([{ ...alertRow, status: 'acknowledged' }]);

    const res = await acknowledgeRequest();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: alertRow.id, status: 'acknowledged' });
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.acknowledged');
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
  });

  it('gives an already-acknowledged alert the SAME 409 the CAS loser gets', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'acknowledged' });

    const res = await acknowledgeRequest();

    // Losing at the pre-read and losing at the CAS are the same real-world event —
    // somebody else acknowledged first — so they must not return two different
    // codes purely on timing. #4099 made exactly this change for resolve.
    expect(res.status).toBe(409);
    expect(updateWheres).toHaveLength(0);
  });

  it('keeps a resolved alert a 400 illegal transition, not a race', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'resolved' });

    const res = await acknowledgeRequest();

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Cannot acknowledge alert with status: resolved',
    });
  });
});

describe('POST /alerts/:id/acknowledge — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND acknowledgeable status', async () => {
    updateReturns.push([{ ...alertRow, status: 'acknowledged' }]);

    await acknowledgeRequest();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    // `or` instead of `and` would stamp every active alert in EVERY tenant
    // acknowledged from one request; dropping the status list makes the write
    // unconditional again (the #4101 bug); admitting any non-active status lets an
    // acknowledge overwrite a resolution. Each changes this string or its params.
    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2))');
    expect(params).toEqual([alertRow.id, 'active']);
  });
});

describe('POST /alerts/:id/suppress — the losing caller', () => {
  it('answers 409 and fans nothing out', async () => {
    updateReturns.push([]); // CAS matched nothing

    const res = await suppressRequest();

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: SUPPRESS_CAS_LOST });
    expect(publishEvent).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});

describe('POST /alerts/:id/suppress — the winning caller', () => {
  it('answers 200 and records the suppression once', async () => {
    updateReturns.push([{ ...alertRow, status: 'suppressed' }]);

    const res = await suppressRequest();

    expect(res.status).toBe(200);
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
  });

  // #10573: only the AI tool used to publish alert.suppressed, so a webhook or
  // flow subscribed to it never fired for a dashboard/API suppress.
  it('publishes alert.suppressed once, with the shared payload shape', async () => {
    updateReturns.push([{ ...alertRow, status: 'suppressed' }]);
    vi.useFakeTimers({ now: new Date('2098-12-31T22:00:00.000Z'), toFake: ['Date'] });
    try {
      expect((await suppressRequest()).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }

    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]).toEqual([
      'alert.suppressed',
      alertRow.orgId,
      {
        alertId: alertRow.id,
        ruleId: null,
        deviceId: alertRow.deviceId,
        suppressedBy: 'user-1',
        suppressedUntil: suppressUntil,
        durationHours: 2,
      },
      'alerts-route',
      { userId: 'user-1' },
    ]);
  });

  it('publishes an indefinite suppression with null until and null duration', async () => {
    updateReturns.push([{ ...alertRow, status: 'suppressed' }]);

    expect((await suppressRequest({})).status).toBe(200);

    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[2]).toMatchObject({ suppressedUntil: null, durationHours: null });
  });

  it('still answers 200 when the event bus is down — the suppression already landed', async () => {
    updateReturns.push([{ ...alertRow, status: 'suppressed' }]);
    publishEvent.mockRejectedValueOnce(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await suppressRequest()).status).toBe(200);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('alert.suppressed'), expect.anything());
    } finally {
      error.mockRestore();
    }
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
  });

  it('keeps a dismissed alert a 400', async () => {
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'dismissed' });

    const res = await suppressRequest();

    expect(res.status).toBe(400);
    expect(updateWheres).toHaveLength(0);
  });
});

describe('POST /alerts/:id/suppress — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND suppressible status', async () => {
    updateReturns.push([{ ...alertRow, status: 'suppressed' }]);

    await suppressRequest();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual([alertRow.id, 'active', 'acknowledged', 'suppressed']);
  });

  it('re-suppressing an already-suppressed alert is still allowed', async () => {
    // `suppressed` is deliberately IN the CAS set: extending or shortening an
    // existing mute is a legitimate operation, unlike re-acknowledging.
    getAlertWithOrgCheck.mockResolvedValue({ ...alertRow, status: 'suppressed' });
    updateReturns.push([{ ...alertRow, status: 'suppressed' }]);

    const res = await suppressRequest();

    expect(res.status).toBe(200);
  });
});

describe('POST /alerts/bulk suppress — alert.suppressed (#10573)', () => {
  const bulkSuppress = (body: Record<string, unknown>) =>
    app.request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'suppress', ...body }),
    });
  const second = { ...alertRow, id: '44444444-4444-4444-8444-444444444444', ruleId: 'rule-2', deviceId: 'device-2' };

  it('publishes once per alert whose CAS won, and not for the loser', async () => {
    selectRows.push([alertRow, second]);
    updateReturns.push([{ id: alertRow.id }], []); // second alert lost the race

    vi.useFakeTimers({ now: new Date('2098-12-31T22:00:00.000Z'), toFake: ['Date'] });
    let res: Response;
    try {
      res = await bulkSuppress({ alertIds: [alertRow.id, second.id], until: suppressUntil });
    } finally {
      vi.useRealTimers();
    }

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ updated: 1, skipped: 1 });
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.suppressed');
    expect(publishEvent.mock.calls[0]?.[2]).toMatchObject({
      alertId: alertRow.id,
      ruleId: null,
      deviceId: alertRow.deviceId,
      suppressedBy: 'user-1',
      suppressedUntil: suppressUntil,
      durationHours: 2,
    });
    expect(publishEvent.mock.calls[0]?.[3]).toBe('alerts-route');
  });

  it('keeps suppressing the rest of the batch when one publish fails', async () => {
    selectRows.push([alertRow, second]);
    updateReturns.push([{ id: alertRow.id }], [{ id: second.id }]);
    publishEvent.mockRejectedValueOnce(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await bulkSuppress({ alertIds: [alertRow.id, second.id] });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ updated: 2, failed: 0 });
    } finally {
      error.mockRestore();
    }
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(publishEvent.mock.calls[1]?.[2]).toMatchObject({ alertId: second.id, durationHours: null });
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(2);
  });

  it('skips terminal alerts without publishing', async () => {
    selectRows.push([{ ...alertRow, status: 'resolved' }]);

    const res = await bulkSuppress({ alertIds: [alertRow.id] });

    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
