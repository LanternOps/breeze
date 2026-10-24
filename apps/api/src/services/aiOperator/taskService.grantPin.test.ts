/**
 * Wisp W02 — an Operator task launched under a delegation grant pins the
 * grant + revision on its row (Wisp design §4.3). Harness copied from
 * taskService.taskLimits.test.ts; this one records the inserted task values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';

const state = vi.hoisted(() => ({
  selectQueue: [] as Array<Array<Record<string, unknown>>>,
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

vi.mock('../../db', () => {
  const next = async () => state.selectQueue.shift() ?? [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: next }) }) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        state.inserted.push({ table, values });
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'new-task' }] }) };
      },
    }),
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
vi.mock('../aiAgents/effectivePolicy', () => ({ resolveEffectiveAgentSystem: vi.fn(async () => null) }));
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

import { admitServiceRecoveryTask } from './taskService';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_ID = '00000000-0000-4000-8000-000000000002';
const DEVICE_ID = '00000000-0000-4000-8000-000000000011';
const USER_ID = '00000000-0000-4000-8000-000000000021';

const input = {
  orgId: ORG_ID,
  agentId: AGENT_ID,
  objective: 'Restore the spooler service',
  originKind: 'chat' as const,
  requesterUserId: USER_ID,
  recipeInput: { deviceId: DEVICE_ID, serviceName: 'spooler', triggeringAlertId: null },
};

const taskValues = () => state.inserted.find((i) => i.table === aiOperatorTasks)?.values;

beforeEach(() => {
  vi.clearAllMocks();
  state.inserted = [];
  state.selectQueue = [
    [{ id: AGENT_ID, kind: 'triage', name: 'Triage', orgId: ORG_ID }],
    [{ id: DEVICE_ID, hostname: 'host-1' }],
  ];
});

describe('admitServiceRecoveryTask — delegation grant pin (Wisp W02)', () => {
  it('admit stamps grantId/grantRevisionId when provided', async () => {
    await expect(admitServiceRecoveryTask({ ...input, grant: { grantId: 'g1', grantRevisionId: 'r1' } }))
      .resolves.toMatchObject({ ok: true });
    expect(taskValues()).toMatchObject({ grantId: 'g1', grantRevisionId: 'r1', requesterUserId: USER_ID });
  });

  it('admit leaves both null when absent', async () => {
    await expect(admitServiceRecoveryTask(input)).resolves.toMatchObject({ ok: true });
    expect(taskValues()).toMatchObject({ grantId: null, grantRevisionId: null });
  });

  it('a grant without a requester is refused before any insert (a grant is always a person\'s)', async () => {
    const result = await admitServiceRecoveryTask({ ...input, requesterUserId: null, grant: { grantId: 'g1', grantRevisionId: 'r1' } });
    expect(result).toMatchObject({ ok: false, refusal: 'invalid_input' });
    expect(state.inserted).toEqual([]);
  });
});
