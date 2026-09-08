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
}));

// `verification.ts` imports `verifyServiceRunningForTask` from this module —
// mock it directly rather than reaching further down into the command-queue
// / device-command machinery it wraps.
vi.mock('../aiAgents/actVerify', () => ({
  verifyServiceRunningForTask: vi.fn(() => Promise.resolve(mockState.serviceVerdict)),
}));

// `verification.ts` only ever does
// `db.select({...}).from(aiAgentFixWatches).where(and(...)).limit(1)`
// wrapped in `runOutsideDbContext(() => withSystemDbAccessContext(...))`, so a
// minimal chainable stub (mirroring the pattern in `fixWatch.test.ts`) is
// sufficient — no real Postgres connection is ever touched.
vi.mock('../../db', () => {
  const selectBuilder: Record<string, unknown> = {
    from: () => selectBuilder,
    where: () => selectBuilder,
    limit: () => Promise.resolve(mockState.watchRow ? [mockState.watchRow] : []),
  };
  return {
    db: { select: () => selectBuilder },
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: async <T>(fn: () => Promise<T> | T): Promise<T> => fn(),
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
}) {
  mockState.serviceVerdict = args.serviceVerdict;
  mockState.watchRow = args.watchRow ?? null;
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
