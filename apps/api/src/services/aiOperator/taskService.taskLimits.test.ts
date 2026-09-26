/**
 * Task-wide budgets at ADMISSION (#6590): `taskMaxPendingPerOrg` and
 * `taskMaxActiveTargets`, resolved from the pinned agent's EFFECTIVE policy.
 *
 * Wiring assertions over a mocked db. The capacity count and the per-org
 * admission lock are stubbed at the loader seam; what these tests pin is that
 * admission consults them, refuses under/at/over correctly with a named
 * reason, inserts NOTHING when it refuses, and still honours an idempotent
 * replay when the org is at capacity (a replay creates no new task).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selectQueue: [] as Array<Array<Record<string, unknown>>>,
  inserts: 0,
  insertReturning: [{ id: 'new-task' }] as Array<{ id: string }>,
}));

vi.mock('../../db', () => {
  const next = async () => state.selectQueue.shift() ?? [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: next }) }) }),
    insert: () => {
      state.inserts += 1;
      return {
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => state.insertReturning }),
        }),
      };
    },
  };
  return {
    db,
    runOutsideDbContext: <T>(fn: () => T) => fn(),
    withSystemDbAccessContext: <T>(fn: () => T) => fn(),
  };
});
vi.mock('../../config/env', () => ({
  aiOperatorTasksEnabled: () => true,
  aiOperatorServiceRecoveryEnabled: () => true,
}));
vi.mock('../aiAgents/effectivePolicy', () => ({ resolveEffectiveAgentSystem: vi.fn() }));
vi.mock('./targetService', () => ({ createTaskTarget: vi.fn(async () => ({ id: 'target-1' })) }));
vi.mock('./stepService', () => ({
  openStep: vi.fn(async () => ({ id: 'step-1' })),
  resolveStepKind: vi.fn(() => 'probe'),
}));
vi.mock('./eventService', () => ({ appendTaskEvent: vi.fn(async () => 1) }));
vi.mock('./taskLimitsLoader', () => ({
  lockOrgTaskAdmission: vi.fn(async () => undefined),
  countPendingTasks: vi.fn(async () => 0),
}));

import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';
import { countPendingTasks, lockOrgTaskAdmission } from './taskLimitsLoader';
import { admitServiceRecoveryTask } from './taskService';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_ID = '00000000-0000-4000-8000-000000000002';
const DEVICE_ID = '00000000-0000-4000-8000-000000000011';

const input = {
  orgId: ORG_ID,
  agentId: AGENT_ID,
  objective: 'Restore the spooler service',
  originKind: 'manual' as const,
  requesterUserId: null,
  recipeInput: { deviceId: DEVICE_ID, serviceName: 'spooler', triggeringAlertId: null },
};

function queueAgentAndDevice() {
  state.selectQueue.push([{ id: AGENT_ID, kind: 'triage', name: 'Triage', orgId: ORG_ID }]);
  state.selectQueue.push([{ id: DEVICE_ID, hostname: 'host-1' }]);
}

function policy(limits: Record<string, number>) {
  vi.mocked(resolveEffectiveAgentSystem).mockResolvedValue(
    { agentId: AGENT_ID, effective: { limits } } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.selectQueue = [];
  state.inserts = 0;
  state.insertReturning = [{ id: 'new-task' }];
  vi.mocked(resolveEffectiveAgentSystem).mockResolvedValue(null);
  vi.mocked(countPendingTasks).mockResolvedValue(0);
});

describe('admission enforces taskMaxPendingPerOrg', () => {
  it('admits UNDER the policy ceiling, having taken the org admission lock first', async () => {
    policy({ taskMaxPendingPerOrg: 5 });
    vi.mocked(countPendingTasks).mockResolvedValue(4);
    queueAgentAndDevice();
    const result = await admitServiceRecoveryTask(input);
    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(lockOrgTaskAdmission).toHaveBeenCalledWith(ORG_ID);
    expect(countPendingTasks).toHaveBeenCalledWith(ORG_ID);
    const lockOrder = vi.mocked(lockOrgTaskAdmission).mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(vi.mocked(countPendingTasks).mock.invocationCallOrder[0]!);
  });

  it('refuses AT the policy ceiling with a named reason and inserts nothing', async () => {
    policy({ taskMaxPendingPerOrg: 5 });
    vi.mocked(countPendingTasks).mockResolvedValue(5);
    queueAgentAndDevice();
    const result = await admitServiceRecoveryTask(input);
    expect(result).toMatchObject({ ok: false, refusal: 'pending_cap_reached' });
    expect((result as { detail: string }).detail).toContain('taskMaxPendingPerOrg');
    expect(state.inserts).toBe(0);
  });

  it('refuses OVER the ceiling', async () => {
    policy({ taskMaxPendingPerOrg: 5 });
    vi.mocked(countPendingTasks).mockResolvedValue(7);
    queueAgentAndDevice();
    expect(await admitServiceRecoveryTask(input)).toMatchObject({ ok: false, refusal: 'pending_cap_reached' });
    expect(state.inserts).toBe(0);
  });

  it('falls back to the default ceiling when the org replaced the pinned agent', async () => {
    vi.mocked(resolveEffectiveAgentSystem).mockResolvedValue(
      { agentId: 'someone-else', effective: { limits: { taskMaxPendingPerOrg: 1000 } } } as never,
    );
    vi.mocked(countPendingTasks).mockResolvedValue(100); // default is 100
    queueAgentAndDevice();
    expect(await admitServiceRecoveryTask(input)).toMatchObject({ ok: false, refusal: 'pending_cap_reached' });
  });

  it('still answers an idempotent replay when the org is at capacity', async () => {
    policy({ taskMaxPendingPerOrg: 5 });
    vi.mocked(countPendingTasks).mockResolvedValue(5);
    queueAgentAndDevice();
    state.selectQueue.push([{ id: 'existing-task' }]);
    const result = await admitServiceRecoveryTask({ ...input, clientIdempotencyKey: 'key-1' });
    expect(result).toEqual({ ok: true, taskId: 'existing-task', replayed: true });
    expect(state.inserts).toBe(0);
  });
});

describe('admission enforces taskMaxActiveTargets', () => {
  // Admission writes exactly one target, and the validator's floor is 1, so a
  // real policy can never refuse this today. The check is still made so the
  // fleet waves inherit an enforced ceiling rather than a comment.
  it('admits AT the ceiling (one target, ceiling 1)', async () => {
    policy({ taskMaxActiveTargets: 1 });
    queueAgentAndDevice();
    expect(await admitServiceRecoveryTask(input)).toMatchObject({ ok: true });
  });

  it('admits UNDER the ceiling', async () => {
    policy({ taskMaxActiveTargets: 4 });
    queueAgentAndDevice();
    expect(await admitServiceRecoveryTask(input)).toMatchObject({ ok: true });
  });

  it('refuses OVER the ceiling with a named reason and inserts nothing', async () => {
    // Out of the validator's range on purpose: the only way to put one target
    // over the ceiling is a ceiling below one.
    policy({ taskMaxActiveTargets: 0 });
    queueAgentAndDevice();
    const result = await admitServiceRecoveryTask(input);
    expect(result).toMatchObject({ ok: false, refusal: 'task_limit_exceeded' });
    expect((result as { detail: string }).detail).toContain('taskMaxActiveTargets');
    expect(state.inserts).toBe(0);
  });
});
