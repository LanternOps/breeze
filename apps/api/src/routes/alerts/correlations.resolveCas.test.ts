import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * POST /correlations/:groupId/{acknowledge,resolve} is a bulk compare-and-swap
 * (#4094), same family as the single-alert routes: `mutateAlerts` used to UPDATE
 * by id alone, so a group resolve could re-stamp — and republish `alert.resolved`
 * for — a member alert a technician or the warranty auto-resolve sweep had
 * already finished a moment earlier.
 *
 * `mutateAlerts` is not exported, so it is driven through the two group routes
 * that call it, via a real Hono app — same shape as `alerts.resolveCas.test.ts`.
 *
 * Two kinds of assertion, deliberately:
 *
 *  - BEHAVIOUR — a member alert absent from the UPDATE's `RETURNING` (the CAS
 *    matched nothing for it) must get no `publishEvent` / `emitAlertStateFeedback`,
 *    while a sibling that DID come back must get both.
 *  - COMPILED SQL — the predicate `mutateAlerts` actually passes to `.where()`,
 *    compiled through `PgDialect`, for BOTH the resolve shape (`status IN (...)`)
 *    and the acknowledge shape (`status = 'active'`) — they differ, and a mocked-
 *    drizzle substring match on column names cannot tell either apart from `or`
 *    or from an admitted terminal status (the wave-3825 test-hardening pass,
 *    `8763a3239`, which is not on main). drizzle-orm and
 *    ../../db/schema are REAL in this file for that reason; only the DB
 *    connection module is mocked.
 */
const {
  dbMock,
  selectQueues,
  alertsUpdateWheres,
  alertsUpdateReturns,
  groupRow,
  alertWin,
  alertLose,
} = vi.hoisted(() => {
  const selectQueues = new Map<string, unknown[][]>();
  const alertsUpdateWheres: unknown[] = [];
  const alertsUpdateReturns: unknown[][] = [];

  const groupId = '22222222-2222-4222-8222-222222222222';
  const groupRow = {
    id: groupId,
    orgId: 'org-1',
    groupKey: 'disk-pressure',
    rootAlertId: null as string | null,
    status: 'open',
    score: null as string | null,
    noiseReductionPercent: 0,
    memberCount: 2,
    firstSeenAt: new Date('2026-08-20T00:00:00Z'),
    lastSeenAt: new Date('2026-08-20T00:00:00Z'),
    metadata: {},
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
  };

  const alertWin = {
    id: '33333333-3333-4333-8333-333333333333',
    orgId: 'org-1',
    deviceId: 'device-1',
    ruleId: null as string | null,
    configPolicyId: null as string | null,
    status: 'active',
    severity: 'high',
    title: 'Disk almost full',
    triggeredAt: new Date('2026-08-20T00:00:00Z'),
  };
  const alertLose = {
    id: '44444444-4444-4444-8444-444444444444',
    orgId: 'org-1',
    deviceId: 'device-2',
    ruleId: null as string | null,
    configPolicyId: null as string | null,
    status: 'active',
    severity: 'high',
    title: 'CPU pegged',
    triggeredAt: new Date('2026-08-20T00:00:00Z'),
  };

  // Same table-keyed queue as alertService.autoResolveOutcome.test.ts: seeds are
  // per real Drizzle table (resolved via its Name symbol), not per call order,
  // so the three selects `getPersistedGroupAlerts` issues (group, members,
  // alerts) don't have to be threaded by hand.
  const tableName = (table: unknown): string => {
    const symbols = Object.getOwnPropertySymbols(table as object);
    for (const symbol of symbols) {
      if (symbol.description?.includes('Name')) {
        const value = (table as Record<symbol, unknown>)[symbol];
        if (typeof value === 'string') return value;
      }
    }
    return 'unknown';
  };
  const take = (table: unknown): unknown[] => selectQueues.get(tableName(table))?.shift() ?? [];

  const dbMock = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = take(table);
          return {
            limit: () => Promise.resolve(rows),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: (table: unknown) => {
      if (tableName(table) === 'alerts') {
        return {
          set: () => ({
            where: (predicate: unknown) => {
              alertsUpdateWheres.push(predicate);
              return { returning: () => Promise.resolve(alertsUpdateReturns.shift() ?? []) };
            },
          }),
        };
      }
      // alert_correlation_groups status mirror (updatePersistedGroupStatus): not
      // under test here, so always "succeeds" without needing its own queue.
      return {
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([{ id: groupRow.id }]) }),
        }),
      };
    },
  };

  return { dbMock, selectQueues, alertsUpdateWheres, alertsUpdateReturns, groupRow, alertWin, alertLose };
});

const publishEvent = vi.fn((..._args: unknown[]) => Promise.resolve('evt'));
const emitAlertStateFeedback = vi.fn((..._args: unknown[]) => Promise.resolve());
const emitCorrelationFeedback = vi.fn((..._args: unknown[]) => Promise.resolve());
const emitRcaFeedback = vi.fn((..._args: unknown[]) => Promise.resolve());
const writeRouteAudit = vi.fn();
const captureException = vi.fn();

vi.mock('../../db', () => ({ db: dbMock }));
vi.mock('../../middleware/auth', () => ({
  // requireScope/requirePermission normally read an `auth` the real
  // authMiddleware set upstream; that middleware isn't mounted on the isolated
  // sub-router under test, so — like alerts.resolveCas.test.ts — these mocks
  // set the context themselves instead of asserting it was already there.
  requireScope: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', {
      scope: 'organization',
      user: { id: 'user-1', name: 'Tech One', email: 'tech@org.example' },
      partnerId: null,
      orgId: 'org-1',
      accessibleOrgIds: null,
      allowedSiteIds: null,
      canAccessOrg: () => true,
    });
    await next();
  },
  requirePermission: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('permissions', { granted: new Set<string>() });
    await next();
  },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: (...a: unknown[]) => writeRouteAudit(...a) }));
vi.mock('../../services/eventBus', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }));
vi.mock('../../services/sentry', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: (...a: unknown[]) => emitAlertStateFeedback(...a),
  emitCorrelationFeedback: (...a: unknown[]) => emitCorrelationFeedback(...a),
  emitRcaFeedback: (...a: unknown[]) => emitRcaFeedback(...a),
}));
vi.mock('../../services/mlFeatureFlags', () => ({ shouldProduceMlOutput: () => Promise.resolve(false) }));
// Phase 2 wave P2-1 (alert verdicts), Task 14 — `correlations.ts` now
// imports `latestVerdictForGroup`/`projectAlertAiVerdictSummary`. Unmocked,
// the real module drags in `createActionIntent` (services/actionIntents/
// intentService.ts) and its own transitive graph (aiTools/aiToolSchemas,
// commandQueue, …), which this file's other partial mocks were never built
// to cover. Mocked here purely to sever that transitive chain — this suite
// doesn't exercise aiVerdict at all.
vi.mock('../../services/aiAgents/alertVerdicts', () => ({
  latestVerdictForGroup: vi.fn(async () => null),
  projectAlertAiVerdictSummary: vi.fn(),
}));

import { alertCorrelationRoutes } from './correlations';

const app = new Hono().route('/', alertCorrelationRoutes);
const dialect = new PgDialect();

/**
 * `reReadRows` is the SECOND `alerts` select — the one `reportUnwrittenAlerts`
 * issues to work out WHY a member wasn't written. It only runs on a shortfall.
 * Pass rows carrying a terminal status to model a benign lost race; pass `[]` to
 * model the row being invisible to this tenant context on re-read, which is the
 * tenancy bug the exception exists to catch.
 */
const seedGroup = (statusWin: string, statusLose: string, reReadRows: unknown[] = []) => {
  selectQueues.clear();
  alertsUpdateWheres.length = 0;
  alertsUpdateReturns.length = 0;
  selectQueues.set('alert_correlation_groups', [[groupRow]]);
  selectQueues.set('alert_correlation_members', [[{ alertId: alertWin.id }, { alertId: alertLose.id }]]);
  selectQueues.set('alerts', [
    [{ ...alertWin, status: statusWin }, { ...alertLose, status: statusLose }],
    reReadRows,
  ]);
};

const resolveGroupRequest = () =>
  app.request(`/correlations/${groupRow.id}/resolve`, { method: 'POST' });
const acknowledgeGroupRequest = () =>
  app.request(`/correlations/${groupRow.id}/acknowledge`, { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
  emitAlertStateFeedback.mockResolvedValue(undefined);
  emitCorrelationFeedback.mockResolvedValue(undefined);
});

describe('POST /correlations/:groupId/resolve — mixed CAS outcome within one group', () => {
  it('fans out only for the member the UPDATE actually returned', async () => {
    seedGroup('active', 'active');
    alertsUpdateReturns.push([{ id: alertWin.id }]); // alert-lose's row is NOT in RETURNING

    const res = await resolveGroupRequest();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ updated: 1, skipped: 1 });

    // The whole point of the CAS: fan-out follows what the UPDATE actually wrote,
    // not the pre-read `eligible` snapshot — a lost race must stay silent.
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.resolved');
    expect(publishEvent.mock.calls[0]?.[2]).toMatchObject({ alertId: alertWin.id });

    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
    expect(emitAlertStateFeedback.mock.calls[0]?.[0]).toMatchObject({ alertId: alertWin.id });
  });

  it('does NOT page when the re-read shows the member simply lost the race', async () => {
    // The signal this exception carries is "a tenant-isolation bug may have eaten
    // a write". Adding the status predicate made an ordinary concurrent resolve
    // produce the same shortfall, so firing on it would bury the real thing in
    // routine noise — the detector-fires-for-everything failure mode.
    seedGroup('active', 'active', [{ id: alertLose.id, status: 'resolved' }]);
    alertsUpdateReturns.push([{ id: alertWin.id }]);

    await resolveGroupRequest();

    expect(captureException).not.toHaveBeenCalled();
  });

  it('DOES page when the unwritten member is invisible on re-read', async () => {
    // Selected moments ago, gone now: the row is not terminal, it is unreachable
    // from this context. That is an RLS scope mismatch, and under breeze_app the
    // write raised no error to reveal it.
    seedGroup('active', 'active', []);
    alertsUpdateReturns.push([{ id: alertWin.id }]);

    await resolveGroupRequest();

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0]?.[0])).toContain('does NOT explain');
  });

  it('DOES page when the unwritten member is still in a mutable status', async () => {
    // Visible, non-terminal, and yet the CAS skipped it — neither explanation
    // fits, so the predicate itself is suspect.
    seedGroup('active', 'active', [{ id: alertLose.id, status: 'active' }]);
    alertsUpdateReturns.push([{ id: alertWin.id }]);

    await resolveGroupRequest();

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('stays silent when every member was written', async () => {
    seedGroup('active', 'active');
    alertsUpdateReturns.push([{ id: alertWin.id }, { id: alertLose.id }]);

    await resolveGroupRequest();

    expect(captureException).not.toHaveBeenCalled();
    expect(publishEvent).toHaveBeenCalledTimes(2);
  });
});

describe('POST /correlations/:groupId/acknowledge — mixed CAS outcome', () => {
  it('fans out only for the member the UPDATE returned', async () => {
    // The acknowledge arm has its own status guard (`= 'active'`, not the
    // three-way resolvable set) and its own event name, so its winner/loser
    // behaviour is asserted here rather than inferred from the resolve arm.
    seedGroup('active', 'active', [{ id: alertLose.id, status: 'acknowledged' }]);
    alertsUpdateReturns.push([{ id: alertWin.id }]);

    const res = await acknowledgeGroupRequest();

    expect(res.status).toBe(200);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.acknowledged');
    expect(publishEvent.mock.calls[0]?.[2]).toMatchObject({ alertId: alertWin.id });
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('POST /correlations/:groupId/resolve — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by member ids AND the resolvable status set', async () => {
    seedGroup('active', 'active');
    alertsUpdateReturns.push([{ id: alertWin.id }, { id: alertLose.id }]);

    await resolveGroupRequest();

    expect(alertsUpdateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(alertsUpdateWheres[0] as SQL);

    // `or` instead of `and` would stamp every active/acknowledged/suppressed alert
    // in the id list regardless of status; admitting 'resolved'/'dismissed' turns
    // the CAS into a no-op. Either mutation changes this string or its params.
    expect(sql).toBe(
      '("alerts"."id" in ($1, $2) and "alerts"."status" in ($3, $4, $5))'
    );
    expect(params).toEqual([alertWin.id, alertLose.id, 'active', 'acknowledged', 'suppressed']);
  });
});

describe('POST /correlations/:groupId/acknowledge — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by member ids AND status = active, not the resolve status set', async () => {
    seedGroup('active', 'active');
    alertsUpdateReturns.push([{ id: alertWin.id }, { id: alertLose.id }]);

    await acknowledgeGroupRequest();

    expect(alertsUpdateWheres).toHaveLength(1);
    const { sql, params } = dialect.sqlToQuery(alertsUpdateWheres[0] as SQL);

    // The acknowledge shape is a single equality, not the three-way resolvable
    // set — swapping in RESOLVABLE_ALERT_STATUSES here would let acknowledge
    // silently re-ack an already-suppressed alert.
    expect(sql).toBe('("alerts"."id" in ($1, $2) and "alerts"."status" = $3)');
    expect(params).toEqual([alertWin.id, alertLose.id, 'active']);
  });
});
