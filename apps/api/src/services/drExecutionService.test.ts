import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const authorizationMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock('./recoveryAuthorizationSubject', () => ({
  captureRecoveryAuthorizationSubject: authorizationMocks.capture,
  authorizeQueuedRecoveryWork: authorizationMocks.authorize,
  RecoveryAuthorizationDeniedError: class RecoveryAuthorizationDeniedError extends Error {
    readonly retriable = false;
    constructor(readonly code: string) { super(code); }
  },
  RecoveryAuthorizationTransientError: class RecoveryAuthorizationTransientError extends Error {
    readonly retriable = true;
    constructor(readonly code: string) { super(code); }
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
import {
  createDrExecutionAndEnqueue,
  reconcileDrExecution,
  resolveDrGroupAuthorizationRefs,
} from './drExecutionService';

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
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.execute).mockReset();
    vi.mocked(db.transaction).mockReset();
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(db));
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as any);
    authorizationMocks.capture.mockResolvedValue({
      authorizationPrincipalKind: 'user_session',
      authorizationPrincipalId: 'user-1',
      authorizationGrantRevision: 'grant-1',
      authorizationState: 'pending',
      authorizationDenialCode: null,
      authorizationCheckedAt: null,
    });
    authorizationMocks.authorize.mockResolvedValue({ subject: {}, resources: { resources: [] } });
  });

  it('resolves every target and explicit source before authorization', async () => {
    const refs = await resolveDrGroupAuthorizationRefs({
      ...groupRow(),
      devices: [DEVICE_ID, '66666666-6666-6666-6666-666666666666'],
      restoreConfig: {
        commandType: 'bmr_recover',
        payload: {
          sourceSnapshotId: '77777777-7777-7777-7777-777777777777',
          recoveryTokenId: '88888888-8888-8888-8888-888888888888',
        },
      },
    }, ORG_ID, { resolveProviderSnapshotId: vi.fn() });

    expect(refs).toEqual([
      { kind: 'device', id: DEVICE_ID, role: 'target' },
      { kind: 'device', id: '66666666-6666-6666-6666-666666666666', role: 'target' },
      { kind: 'snapshot', id: '77777777-7777-7777-7777-777777777777', role: 'source' },
      { kind: 'recovery_token', id: '88888888-8888-8888-8888-888888888888', role: 'source' },
    ]);
  });

  it('fails closed when a provider snapshot id is ambiguous', async () => {
    await expect(resolveDrGroupAuthorizationRefs(groupRow(), ORG_ID, {
      resolveProviderSnapshotId: vi.fn().mockRejectedValue(new Error('ambiguous_snapshot_reference')),
    })).rejects.toThrow('ambiguous_snapshot_reference');
  });

  it('fails the entire group when any target device id is malformed', async () => {
    await expect(resolveDrGroupAuthorizationRefs({
      ...groupRow(),
      devices: [DEVICE_ID, 'malformed-device'],
    }, ORG_ID, {
      resolveProviderSnapshotId: vi.fn().mockResolvedValue('77777777-7777-7777-7777-777777777777'),
    })).rejects.toThrow('resource_not_found');
  });

  it('normalizes duplicate target ids to one authorization and command identity', async () => {
    const refs = await resolveDrGroupAuthorizationRefs({
      ...groupRow(),
      devices: [DEVICE_ID, DEVICE_ID],
    }, ORG_ID, {
      resolveProviderSnapshotId: vi.fn().mockResolvedValue('77777777-7777-7777-7777-777777777777'),
    });

    expect(refs.filter((ref) => ref.kind === 'device')).toEqual([
      { kind: 'device', id: DEVICE_ID, role: 'target' },
    ]);
  });

  it('creates a DR execution with initial manifest and enqueues reconciliation', async () => {
    const insertChain = createInsertChain([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'pending',
    }]);
    vi.mocked(db.select)
      .mockImplementationOnce(() => createQueryChain([groupRow()]) as any)
      .mockImplementationOnce(() => createQueryChain([{
        id: '77777777-7777-7777-7777-777777777777',
        snapshotId: 'snap-1',
      }]) as any);
    vi.mocked(db.insert).mockImplementationOnce(() => insertChain as any);

    const execution = await createDrExecutionAndEnqueue({
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      initiatedBy: 'user-1',
      auth: { principal: { kind: 'user_session' } } as any,
    });

    expect(execution?.id).toBe(EXECUTION_ID);
    expect(authorizationMocks.capture).toHaveBeenCalled();
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({
      authorizationPrincipalKind: 'user_session',
      authorizationPrincipalId: 'user-1',
      authorizationGrantRevision: 'grant-1',
      authorizationState: 'pending',
    }));
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
      .mockImplementationOnce(() => createQueryChain([groupRow()]) as any)
      .mockImplementationOnce(() => createQueryChain([{
        id: '77777777-7777-7777-7777-777777777777',
        snapshotId: 'snap-1',
      }]) as any);
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
      // expectedOrgId threads the plan's org through to commandQueue's
      // cross-tenant guard so a foreign device id in devices[] is refused.
      { userId: 'user-1', expectedOrgId: ORG_ID }
    );
    expect(execution.execution?.status).toBe('running');
    expect(execution?.nextDelayMs).toBe(2000);
    expect(enqueueDrExecutionReconcile).not.toHaveBeenCalled();
  });

  it('durably denies revoked authority before any command or running transition', async () => {
    const deniedExecution = {
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'pending',
      startedAt: new Date('2026-03-30T00:00:00.000Z'),
      completedAt: null,
      initiatedBy: 'user-1',
      results: { authorizedDeviceIds: [DEVICE_ID] },
      createdAt: new Date('2026-03-30T00:00:00.000Z'),
      authorizationPrincipalKind: 'user_session',
      authorizationPrincipalId: 'user-1',
      authorizationGrantRevision: 'grant-1',
      authorizationState: 'pending',
      authorizationDenialCode: null,
      authorizationCheckedAt: null,
    };
    vi.mocked(db.select)
      .mockImplementationOnce(() => createQueryChain([deniedExecution]) as any)
      .mockImplementationOnce(() => createQueryChain([groupRow()]) as any)
      .mockImplementationOnce(() => createQueryChain([{
        id: '77777777-7777-7777-7777-777777777777',
        snapshotId: 'snap-1',
      }]) as any);
    authorizationMocks.authorize.mockRejectedValueOnce(Object.assign(new Error('base_permission_denied'), {
      code: 'base_permission_denied',
      retriable: false,
    }));
    vi.mocked(db.update).mockImplementationOnce(() => createUpdateChain([{
      ...deniedExecution,
      status: 'failed',
      authorizationState: 'denied',
      authorizationDenialCode: 'base_permission_denied',
    }]) as any);

    const outcome = await reconcileDrExecution(EXECUTION_ID);

    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(outcome.execution?.status).toBe('failed');
    expect(outcome.execution?.authorizationState).toBe('denied');
    expect(outcome.nextDelayMs).toBeNull();
  });
});
