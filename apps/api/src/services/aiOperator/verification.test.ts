// apps/api/src/services/aiOperator/verification.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { TaskCriterion } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-000000000031';
const DEVICE_ID = '00000000-0000-4000-8000-000000000032';
const ALERT_ID = '00000000-0000-4000-8000-000000000033';
const INTENT_ID = '00000000-0000-4000-8000-000000000034';
const AGENT_USER_ID = '00000000-0000-4000-8000-000000000035';

type ServiceVerdict = { verification: 'passed' | 'failed' | 'inconclusive' | 'skipped'; detail?: string };
type WatchRow = { state: string; dueAt: Date | null } | null;

// Mutable, per-test-controllable mock state. `vi.hoisted` is required because
// `vi.mock` factories are hoisted above imports, so a plain module-scope
// `let` declared below would not exist yet when the factory runs.
const mockState = vi.hoisted(() => ({
  serviceVerdict: { verification: 'passed', detail: 'service is running' } as ServiceVerdict,
  watchRow: null as WatchRow,
  /** Whether the target device still resolves inside the task's org. */
  deviceInOrg: true,
}));

// `verification.ts` imports `verifyServiceRunningForTask` from this module —
// mock it directly rather than reaching further down into the command-queue
// / device-command machinery it wraps.
vi.mock('../aiAgents/actVerify', () => ({
  verifyServiceRunningForTask: vi.fn(() => Promise.resolve(mockState.serviceVerdict)),
}));

// `verification.ts` makes exactly TWO reads, and this stub keeps them apart by
// the TABLE passed to `.from(...)` rather than by call order:
//
//   1. `devices`            — the org-ownership probe in `readServiceRunning`,
//                             under the task's own org context;
//   2. `aiAgentFixWatches`  — the recurrence half, system-scoped.
//
// Discriminating on the table matters. An order-based stub (first call =
// devices, second = watch) would keep passing if the two reads were ever
// swapped or one were dropped, which is exactly the "mock returns whatever it
// was handed regardless of the query" failure this repo has shipped before.
// The cross-tenant behaviour itself is proven against real Postgres in
// `aiOperatorCoordinator.integration.test.ts`; this stub only has to let the
// eleven verdict cases below reach the logic they are about.
vi.mock('../../db', () => {
  // Discriminates on the SELECTED FIELDS, not on call order. An order-based
  // stub (first call = devices, second = watch) would keep passing if the two
  // reads were ever swapped or one were dropped — exactly the "mock returns
  // whatever it was handed regardless of the query" failure this repo has
  // shipped before. The watch read asks for `state`; the ownership probe does
  // not.
  const build = (rows: () => unknown[]) => {
    const builder: Record<string, unknown> = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(rows()),
    };
    return builder;
  };
  return {
    db: {
      select: (fields?: Record<string, unknown>) => (
        fields && 'state' in fields
          ? build(() => (mockState.watchRow ? [mockState.watchRow] : []))
          : build(() => (mockState.deviceInOrg ? [{ id: 'device' }] : []))
      ),
    },
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: async <T>(fn: () => Promise<T> | T): Promise<T> => fn(),
    withDbAccessContext: async <T>(_ctx: unknown, fn: () => Promise<T> | T): Promise<T> => fn(),
  };
});

const { evaluateCriterion } = await import('./verification');

function criterion(overrides: Partial<TaskCriterion> = {}): TaskCriterion {
  return {
    adapter: 'service_running',
    adapterVersion: 1,
    deviceId: DEVICE_ID,
    serviceName: 'spooler',
    freshnessSeconds: 120,
    alertId: null,
    resolvableWithoutAlert: false,
    ...overrides,
  };
}

async function evaluate(args: {
  serviceVerdict: ServiceVerdict;
  watchRow?: WatchRow;
  alertId?: string | null;
  resolvableWithoutAlert?: boolean;
  intentId?: string | null;
  /** Defaults true; set false to exercise the device-left-the-org branch. */
  deviceInOrg?: boolean;
}) {
  mockState.serviceVerdict = args.serviceVerdict;
  mockState.watchRow = args.watchRow ?? null;
  mockState.deviceInOrg = args.deviceInOrg ?? true;
  return evaluateCriterion({
    orgId: ORG_ID,
    criterion: criterion({
      alertId: args.alertId ?? null,
      resolvableWithoutAlert: args.resolvableWithoutAlert ?? false,
    }),
    agentUserId: AGENT_USER_ID,
    intentId: args.intentId ?? null,
  });
}

describe('evaluateCriterion — the device must still be in the task org', () => {
  it('returns inconclusive, not failed, when the device has left the org', async () => {
    // A durable task can sit `waiting` for days; the device can be moved to
    // another organization in the meantime. `readServiceRunning` re-validates
    // ownership under the task's own org context BEFORE dispatching anything,
    // because the command-queue precheck underneath resolves the device by id
    // with no org predicate under a system scope.
    //
    // `inconclusive` and not `failed`: nothing was learned about the service,
    // and `failed` is the branch that authorizes another restart attempt.
    const result = await evaluate({
      serviceVerdict: { verification: 'passed' },
      deviceInOrg: false,
      alertId: null,
    });

    expect(result.result).toBe('inconclusive');
    expect(result.outcome).toBeNull();
    expect(result.detail).toMatch(/no longer in this organization/i);
  });
});

describe('evaluateCriterion — the C9 freshness bound', () => {
  // Contradiction C9: no freshness bound existed anywhere in the codebase
  // before this wave. `VERIFY_READ_TIMEOUT_MS` (8s) is a read DEADLINE and
  // `FIX_HOLD_MINUTES` (60) is a recurrence HOLD; neither bounds staleness.
  // The criterion therefore carries its own `freshnessSeconds`, and this is
  // the only thing that stops a slow device round-trip — one that lands after
  // the window it was supposed to answer — from being credited as current
  // evidence of recovery.
  //
  // `evaluateCriterion` takes an injectable `now` for exactly this reason;
  // the branch is unreachable in a real call, where the read happens
  // milliseconds before the comparison.

  it('refuses to credit a service read older than freshnessSeconds', async () => {
    mockState.deviceInOrg = true;
    mockState.serviceVerdict = { verification: 'passed' };
    mockState.watchRow = { state: 'held_qualified', dueAt: null };

    const result = await evaluateCriterion({
      orgId: ORG_ID,
      criterion: { ...criterion({ freshnessSeconds: 120 }), alertId: null },
      agentUserId: AGENT_USER_ID,
      intentId: null,
      // The read is taken at call time; a `now` two minutes and one second
      // later makes that evidence stale by exactly one second.
      now: new Date(Date.now() + 121_000),
    });

    expect(result.result).toBe('inconclusive');
    expect(result.outcome).toBeNull();
    expect(result.detail).toMatch(/freshness bound/i);
  });

  it('credits a read INSIDE the window — the bound is a bound, not a blanket refusal', async () => {
    // The control. Without it the assertion above would pass just as happily
    // against an implementation that returned `inconclusive` unconditionally.
    mockState.deviceInOrg = true;
    mockState.serviceVerdict = { verification: 'passed' };
    mockState.watchRow = null;

    const result = await evaluateCriterion({
      orgId: ORG_ID,
      criterion: { ...criterion({ freshnessSeconds: 120 }), alertId: null },
      agentUserId: AGENT_USER_ID,
      intentId: null,
      now: new Date(Date.now() + 60_000),
    });

    expect(result.result).toBe('passed');
    expect(result.outcome).toBe('investigation_complete');
  });

  it('the staleness check runs BEFORE the verdict is read — a stale FAILURE is inconclusive too', async () => {
    // A stale read is not evidence in either direction. Reporting a stale
    // `failed` as a real failure would admit another restart attempt against
    // a service that may have recovered minutes ago.
    mockState.deviceInOrg = true;
    mockState.serviceVerdict = { verification: 'failed', detail: 'service status is "stopped"' };
    mockState.watchRow = null;

    const result = await evaluateCriterion({
      orgId: ORG_ID,
      criterion: { ...criterion({ freshnessSeconds: 60 }), alertId: null },
      agentUserId: AGENT_USER_ID,
      intentId: null,
      now: new Date(Date.now() + 61_000),
    });

    expect(result.result).toBe('inconclusive');
    expect(result.detail).toMatch(/freshness bound/i);
  });
});

describe('evaluateCriterion (spec §8.1, baseline §2.7, C9/C10/C11)', () => {
  type Case = {
    name: string;
    args: Parameters<typeof evaluate>[0];
    expectedResult: string;
    expectedOutcome: string | null;
    expectedAwaitingWindow?: boolean;
  };

  const cases: Case[] = [
    {
      name: 'service read inconclusive -> inconclusive, no outcome',
      args: { serviceVerdict: { verification: 'inconclusive', detail: 'read timed out' } },
      expectedResult: 'inconclusive',
      expectedOutcome: null,
    },
    {
      name: 'service read failed -> failed, no outcome',
      args: { serviceVerdict: { verification: 'failed', detail: 'service is stopped' } },
      expectedResult: 'failed',
      expectedOutcome: null,
    },
    {
      name: 'passed + alertId null + resolvableWithoutAlert false -> passed / ' +
        'investigation_complete (NOT verified_resolved — C11)',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: null,
        resolvableWithoutAlert: false,
      },
      expectedResult: 'passed',
      expectedOutcome: 'investigation_complete',
    },
    {
      name: 'passed + alertId null + resolvableWithoutAlert true -> verified_resolved',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: null,
        resolvableWithoutAlert: true,
      },
      expectedResult: 'passed',
      expectedOutcome: 'verified_resolved',
    },
    {
      name: 'passed + alertId set + no intentId -> inconclusive (nothing dispatched, ' +
        'recovery cannot be attributed)',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: ALERT_ID,
        intentId: null,
      },
      expectedResult: 'inconclusive',
      expectedOutcome: null,
    },
    {
      name: 'passed + alertId + watch held_qualified -> verified_resolved (the ONLY path)',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: ALERT_ID,
        intentId: INTENT_ID,
        watchRow: { state: 'held_qualified', dueAt: null },
      },
      expectedResult: 'passed',
      expectedOutcome: 'verified_resolved',
    },
    {
      name: 'watch recurred -> failed',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: ALERT_ID,
        intentId: INTENT_ID,
        watchRow: { state: 'recurred', dueAt: null },
      },
      expectedResult: 'failed',
      expectedOutcome: null,
    },
    {
      name: 'watch pending -> inconclusive, awaitingWindow true',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: ALERT_ID,
        intentId: INTENT_ID,
        watchRow: { state: 'pending', dueAt: null },
      },
      expectedResult: 'inconclusive',
      expectedOutcome: null,
      expectedAwaitingWindow: true,
    },
    {
      name: 'watch watching -> inconclusive, awaitingWindow true',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: ALERT_ID,
        intentId: INTENT_ID,
        watchRow: { state: 'watching', dueAt: null },
      },
      expectedResult: 'inconclusive',
      expectedOutcome: null,
      expectedAwaitingWindow: true,
    },
    {
      name: 'watch cancelled (human dismissed the alert) -> inconclusive, NOT passed',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: ALERT_ID,
        intentId: INTENT_ID,
        watchRow: { state: 'cancelled', dueAt: null },
      },
      expectedResult: 'inconclusive',
      expectedOutcome: null,
    },
    {
      name: 'no watch row at all -> inconclusive, awaitingWindow true',
      args: {
        serviceVerdict: { verification: 'passed', detail: 'service is running' },
        alertId: ALERT_ID,
        intentId: INTENT_ID,
        watchRow: null,
      },
      expectedResult: 'inconclusive',
      expectedOutcome: null,
      expectedAwaitingWindow: true,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const evaluation = await evaluate(c.args);
      expect(evaluation.result).toBe(c.expectedResult);
      expect(evaluation.outcome).toBe(c.expectedOutcome);
      if (c.expectedAwaitingWindow !== undefined) {
        expect(evaluation.awaitingWindow).toBe(c.expectedAwaitingWindow);
      }
    });
  }

  it('NEVER returns outcome === verified_resolved for any case whose result is not ' +
    "'passed' (spec §13 acceptance scenario 7: inconclusive can never produce " +
    'completed + verified_resolved)', async () => {
    for (const c of cases) {
      const evaluation = await evaluate(c.args);
      if (evaluation.result !== 'passed') {
        expect(evaluation.outcome).not.toBe('verified_resolved');
      }
    }
  });
});
