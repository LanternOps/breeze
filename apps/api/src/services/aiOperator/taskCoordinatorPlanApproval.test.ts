/**
 * The coordinator's `effect` and `probe` step kinds (Recipe Library E4,
 * #6169), tested at the seam only.
 *
 * The behaviour lives in effectDispatch.ts / planApproval.ts and is tested
 * there. Asserted HERE: the two kinds route through KIND_ADVANCERS to
 * `planEffectStep` / `planProbeStep`; each typed directive becomes exactly one
 * leased write (wait / settle / move); and a planner throw SETTLES rather than
 * escaping (a throw would leave the BullMQ wake job retrying forever).
 * Harness mirrors taskCoordinatorHumanWork.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition } from './recipes/types';

const dbState = vi.hoisted(() => ({
  casRows: [{ id: 'task-1' }] as Array<{ id: string }>,
  taskPatches: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => {
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        dbState.taskPatches.push(patch);
        return { where: () => ({ returning: async () => dbState.casRows }) };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'target-1' }] }) }) }),
  };
  return { db, runOutsideDbContext: <T>(fn: () => T) => fn(), withSystemDbAccessContext: <T>(fn: () => T) => fn() };
});
vi.mock('./stepService', () => ({
  openStep: vi.fn(async () => ({ id: 'step-1' })),
  markStepWaiting: vi.fn(async () => 1),
  settleStep: vi.fn(async () => 1),
  resolveStepKind: vi.fn(() => 'effect'),
}));
vi.mock('./eventService', () => ({ appendTaskEvent: vi.fn(async () => 1) }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiOperatorTasksEnabled: () => true,
}));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: vi.fn() }));
vi.mock('./effectDispatch', () => ({ planEffectStep: vi.fn(), planProbeStep: vi.fn() }));

import { planEffectStep, planProbeStep } from './effectDispatch';
import { markStepWaiting, openStep } from './stepService';
import { advanceEffect, advanceProbe } from './taskCoordinator';

const recipe = {
  key: 'fixture_identity', version: 1, steps: {
    offboard: { kind: 'effect', phase: 'execute' },
    verify_outcome: { kind: 'probe', phase: 'verify' },
  },
} as unknown as RecipeDefinition<never>;
const NOW = new Date('2026-10-20T10:00:00.000Z');
const args = (stepKey = 'offboard') => ({
  task: {
    id: 'task-1', orgId: 'org-1', revision: 3, leaseEpoch: 4, attemptOrdinal: 0, state: 'running',
    workflowKey: 'fixture_identity', workflowVersion: 1, currentStepKey: stepKey,
  } as never,
  leaseEpoch: 4, checkpoint: {} as never, recipe, now: NOW,
});
const planEffect = vi.mocked(planEffectStep);
const planProbe = vi.mocked(planProbeStep);
const lastPatch = () => dbState.taskPatches.at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  dbState.casRows = [{ id: 'task-1' }];
  dbState.taskPatches = [];
});

describe('advanceEffect', () => {
  it('a wait directive waits on the named intent and releases the lease', async () => {
    planEffect.mockResolvedValue({
      action: 'wait', reason: 'approval', dependency: { kind: 'intent', id: 'intent-9' }, wakeAfterMs: 60_000, detail: 'awaiting',
    });
    await expect(advanceEffect(args())).resolves.toMatch(/^waiting:/);
    expect(lastPatch()).toMatchObject({
      waitReason: 'approval', waitDependencyKind: 'intent', waitDependencyId: 'intent-9', leaseOwner: null,
    });
    expect(markStepWaiting).toHaveBeenCalled();
  });

  it('a settle directive terminalizes with the directive\'s outcome and handoff summary', async () => {
    planEffect.mockResolvedValue({
      action: 'settle', event: 'hand_off', outcome: 'unresolved', detail: 'refused', handoffSummary: 'Nothing was changed.',
    });
    await expect(advanceEffect(args())).resolves.toMatch(/^handed off|^settled/);
    expect(lastPatch()).toMatchObject({ outcome: 'unresolved', handoffSummary: 'Nothing was changed.' });
  });

  it('a move directive settles the step and opens the successor', async () => {
    planEffect.mockResolvedValue({ action: 'move', toStepKey: 'verify_outcome', settledDetail: 'done', resolvedDetail: 'done' });
    await expect(advanceEffect(args())).resolves.toMatch(/^advanced:/);
    expect(lastPatch()).toMatchObject({ currentStepKey: 'verify_outcome' });
    expect(openStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepKey: 'verify_outcome' }));
  });

  it('a planner THROW (infrastructure fault) propagates for retry and writes nothing — it never terminalizes the task', async () => {
    planEffect.mockRejectedValue(new Error('db down'));
    await expect(advanceEffect(args())).rejects.toThrow('db down');
    expect(dbState.taskPatches).toHaveLength(0);
  });
});

describe('advanceProbe', () => {
  it('routes to planProbeStep and applies its directive', async () => {
    planProbe.mockResolvedValue({ action: 'settle', event: 'complete', outcome: 'verified_resolved', detail: 'all observed' });
    await advanceProbe(args('verify_outcome'));
    expect(planProbe).toHaveBeenCalledTimes(1);
    expect(lastPatch()).toMatchObject({ outcome: 'verified_resolved' });
  });
});

describe('coordinator invariants are untouched by E4', () => {
  const src = readFileSync(join(__dirname, 'taskCoordinator.ts'), 'utf8');
  it('still states all three invariants, verbatim', () => {
    expect(src).toContain('IT HOLDS NOTHING WHILE WAITING');
    expect(src).toContain('IT NEVER TRUSTS THE WAKE PAYLOAD');
    expect(src).toContain('`revision` IS THE PLAN REVISION, NOT A CAS COUNTER');
  });
  it('the effect and probe kinds are KIND_ADVANCERS entries; execution stays out of recipes', () => {
    expect(src).toMatch(/effect: \(a\) => advanceEffect\(a\)/);
    expect(src).toMatch(/probe: \(a\) => advanceProbe\(a\)/);
    expect(src).not.toMatch(/recipe\.(dispatch|execute|probe)\(/);
  });
});
