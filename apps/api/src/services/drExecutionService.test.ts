import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: {
    VM_RESTORE_FROM_BACKUP: 'vm_restore_from_backup',
    VM_INSTANT_BOOT: 'vm_instant_boot',
    HYPERV_RESTORE: 'hyperv_restore',
    MSSQL_RESTORE: 'mssql_restore',
    BMR_RECOVER: 'bmr_recover',
  },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../jobs/drExecutionWorker', () => ({
  enqueueDrExecutionReconcile: vi.fn(),
}));

import { db } from '../db';
import { queueCommandForExecution } from './commandQueue';
import { enqueueDrExecutionReconcile } from '../jobs/drExecutionWorker';
import { createDrExecutionAndEnqueue, reconcileDrExecution } from './drExecutionService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PLAN_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';
const EXECUTION_ID = '44444444-4444-4444-4444-444444444444';
const DEVICE_ID = '55555555-5555-5555-5555-555555555555';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function createInsertChain(rows: any[] = []) {
  const chain: any = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function createUpdateChain(rows: any[] = []) {
  const chain: any = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function groupRow() {
  return {
    id: GROUP_ID,
    planId: PLAN_ID,
    orgId: ORG_ID,
    name: 'Tier 1',
    sequence: 1,
    dependsOnGroupId: null,
    devices: [DEVICE_ID],
    restoreConfig: {
      commandType: 'vm_restore_from_backup',
      payload: { snapshotId: 'snap-1' },
    },
    estimatedDurationMinutes: 30,
  };
}

describe('drExecutionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a DR execution with initial manifest and enqueues reconciliation', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => createQueryChain([groupRow()]) as any);
    vi.mocked(db.insert).mockImplementationOnce(() => createInsertChain([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'pending',
    }]) as any);

    const execution = await createDrExecutionAndEnqueue({
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      initiatedBy: 'user-1',
    });

    expect(execution?.id).toBe(EXECUTION_ID);
    expect(enqueueDrExecutionReconcile).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it('dispatches the next pending group when reconciling a new execution', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createQueryChain([{
        id: EXECUTION_ID,
        planId: PLAN_ID,
        orgId: ORG_ID,
        executionType: 'rehearsal',
        status: 'pending',
        startedAt: new Date('2026-03-30T00:00:00.000Z'),
        completedAt: null,
        initiatedBy: 'user-1',
        results: null,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
      }]) as any)
      .mockImplementationOnce(() => createQueryChain([groupRow()]) as any);
    vi.mocked(queueCommandForExecution).mockResolvedValueOnce({
      command: {
        id: 'cmd-1',
        status: 'sent',
      },
    } as any);
    vi.mocked(db.update).mockImplementationOnce(() => createUpdateChain([{
      id: EXECUTION_ID,
      status: 'running',
    }]) as any);

    const execution = await reconcileDrExecution(EXECUTION_ID);

    expect(queueCommandForExecution).toHaveBeenCalledWith(
      DEVICE_ID,
      'vm_restore_from_backup',
      expect.objectContaining({
        drExecutionId: EXECUTION_ID,
        drPlanId: PLAN_ID,
        drGroupId: GROUP_ID,
      }),
      { userId: 'user-1' }
    );
    expect(execution?.status).toBe('running');
    expect(enqueueDrExecutionReconcile).toHaveBeenCalledWith(EXECUTION_ID, 2000);
  });
});
