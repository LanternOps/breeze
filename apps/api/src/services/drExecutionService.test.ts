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

// ── W05b Task 8 collaborators ───────────────────────────────────────────────
const bmrMocks = vi.hoisted(() => ({
  createBareMetalRecovery: vi.fn(),
  mintRecoveryTokenForRecovery: vi.fn(),
  cancelBareMetalRecovery: vi.fn(),
  queueBareMetalRebuild: vi.fn(),
  resolveLatestRestorableSnapshotId: vi.fn(),
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('./bareMetalRecoveryService', () => ({
  BareMetalRecoveryError: class BareMetalRecoveryError extends Error {
    constructor(public code: string, public status: number, public details?: Record<string, unknown>) {
      super(code);
      this.name = 'BareMetalRecoveryError';
    }
  },
  createBareMetalRecovery: bmrMocks.createBareMetalRecovery,
  mintRecoveryTokenForRecovery: bmrMocks.mintRecoveryTokenForRecovery,
  cancelBareMetalRecovery: bmrMocks.cancelBareMetalRecovery,
}));
vi.mock('./bareMetalRebuildCommand', () => ({
  queueBareMetalRebuild: bmrMocks.queueBareMetalRebuild,
}));
vi.mock('./drBareMetalRebuildStep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./drBareMetalRebuildStep')>()),
  resolveLatestRestorableSnapshotId: bmrMocks.resolveLatestRestorableSnapshotId,
}));
vi.mock('./auditService', () => ({
  createAuditLogAsync: bmrMocks.createAuditLogAsync,
}));

import { db } from '../db';
import { queueCommandForExecution } from './commandQueue';
import { enqueueDrExecutionReconcile } from '../jobs/drExecutionWorker';
import { BareMetalRecoveryError } from './bareMetalRecoveryService';
import {
  classifyDrExecutionAuthorizationError,
  computeGroupResults,
  createDrExecutionAndEnqueue,
  dispatchGroup,
  DrRecoveryAuthorizationDeniedError,
  reconcileDrExecution,
  resolveDrGroupAuthorizationRefs,
  type DrExecutionResults,
} from './drExecutionService';
import {
  RecoveryAuthorizationDeniedError,
  RecoveryAuthorizationTransientError,
} from './recoveryAuthorizationSubject';
import { ResilienceAuthorizationError } from './resilienceSiteAuthorization';

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

  // ── W05b Task 7: BARE_METAL_REBUILD source + rebuild-host refs ──────────
  const DEVICE_2 = '66666666-6666-6666-6666-666666666666';
  const HOST_ID = '99999999-9999-9999-9999-999999999999';
  const SNAP_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const SNAP_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

  it('BARE_METAL_REBUILD: one snapshot source per device from its latest restorable snapshot, plus the host as a target', async () => {
    const resolveLatestRestorableSnapshotId = vi.fn(async (_orgId: string, deviceId: string) =>
      deviceId === DEVICE_ID ? SNAP_1 : SNAP_2);
    const refs = await resolveDrGroupAuthorizationRefs({
      ...groupRow(),
      devices: [DEVICE_ID, DEVICE_2],
      restoreConfig: {
        commandType: 'BARE_METAL_REBUILD',
        snapshotSelection: 'latest_restorable',
        rebuildHostDeviceId: HOST_ID,
        waitTimeoutMinutes: 60,
      },
    }, ORG_ID, { resolveProviderSnapshotId: vi.fn(), resolveLatestRestorableSnapshotId });

    expect(refs).toEqual([
      { kind: 'device', id: DEVICE_ID, role: 'target' },
      { kind: 'device', id: DEVICE_2, role: 'target' },
      { kind: 'device', id: HOST_ID, role: 'target' },
      { kind: 'snapshot', id: SNAP_1, role: 'source' },
      { kind: 'snapshot', id: SNAP_2, role: 'source' },
    ]);
    expect(resolveLatestRestorableSnapshotId).toHaveBeenCalledWith(ORG_ID, DEVICE_ID);
    expect(resolveLatestRestorableSnapshotId).toHaveBeenCalledWith(ORG_ID, DEVICE_2);
  });

  it('BARE_METAL_REBUILD: a device with no restorable snapshot denies the group (resource_not_found)', async () => {
    const resolveLatestRestorableSnapshotId = vi.fn(async (_o: string, d: string) => (d === DEVICE_ID ? SNAP_1 : null));
    const err = await resolveDrGroupAuthorizationRefs({
      ...groupRow(),
      devices: [DEVICE_ID, DEVICE_2],
      restoreConfig: { commandType: 'BARE_METAL_REBUILD' },
    }, ORG_ID, {
      resolveProviderSnapshotId: vi.fn(),
      resolveLatestRestorableSnapshotId,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DrRecoveryAuthorizationDeniedError);
    expect((err as DrRecoveryAuthorizationDeniedError).code).toBe('resource_not_found');
    expect(resolveLatestRestorableSnapshotId).toHaveBeenCalledWith(ORG_ID, DEVICE_2);
  });

  it('BARE_METAL_REBUILD: an invalid step config is denied before any snapshot lookup', async () => {
    const resolveLatestRestorableSnapshotId = vi.fn();
    await expect(resolveDrGroupAuthorizationRefs({
      ...groupRow(),
      restoreConfig: { commandType: 'BARE_METAL_REBUILD', waitTimeoutMinutes: 2 },
    }, ORG_ID, { resolveProviderSnapshotId: vi.fn(), resolveLatestRestorableSnapshotId }))
      .rejects.toThrow('invalid_step_config');
    expect(resolveLatestRestorableSnapshotId).not.toHaveBeenCalled();
  });

  it('other step types still deny a group with no source', async () => {
    await expect(resolveDrGroupAuthorizationRefs({
      ...groupRow(),
      restoreConfig: { commandType: 'vm_restore_from_backup', payload: {} },
    }, ORG_ID, {
      resolveProviderSnapshotId: vi.fn(),
      resolveLatestRestorableSnapshotId: vi.fn().mockResolvedValue(SNAP_1),
    })).rejects.toThrow('resource_not_found');
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

// ── W05b Task 8: BARE_METAL_REBUILD dispatch + reconcile through recovery rows ──
describe('BARE_METAL_REBUILD dispatch and reconcile', () => {
  const DEVICE_2 = '66666666-6666-6666-6666-666666666666';
  const HOST_ID = '99999999-9999-9999-9999-999999999999';
  const SNAP_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const SNAP_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const REC_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const REC_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  // Recent, so a recovery created "at T0" is inside every wait budget when reconcile reads the real clock.
  const T0 = new Date(Date.now() - 5 * 60_000);

  function bmrGroup(overrides: Record<string, unknown> = {}) {
    return {
      ...groupRow(),
      devices: [DEVICE_ID, DEVICE_2],
      restoreConfig: {
        commandType: 'BARE_METAL_REBUILD',
        snapshotSelection: 'latest_restorable',
        rebuildHostDeviceId: HOST_ID,
        outputDir: '/srv/rebuild/out',
        waitTimeoutMinutes: 60,
      },
      ...overrides,
    };
  }

  function execution(executionType: 'rehearsal' | 'failover' | 'failback', results: unknown = null) {
    return {
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType,
      status: 'pending',
      startedAt: T0,
      completedAt: null,
      initiatedBy: 'user-1',
      results,
      createdAt: T0,
      authorizationPrincipalKind: 'user_session',
      authorizationPrincipalId: 'user-1',
      authorizationGrantRevision: 'grant-1',
      authorizationState: 'authorized',
      authorizationDenialCode: null,
      authorizationCheckedAt: T0,
    } as any;
  }

  function recoveryRow(id: string, deviceId: string, status: string, extra: Record<string, unknown> = {}) {
    return {
      id, orgId: ORG_ID, deviceId, snapshotId: SNAP_1, status, identity: 'original', failureReason: null,
      executingDeviceId: null, drExecutionId: EXECUTION_ID, drGroupId: GROUP_ID,
      createdAt: T0, updatedAt: T0, completedAt: null, checkedInAt: null, ...extra,
    } as any;
  }

  function initialResults(): DrExecutionResults {
    return {
      dispatchStatus: 'queued', queuedAt: T0.toISOString(), groupCount: 1, deviceCount: 2,
      plannedGroups: [], queuedCommands: [], queuedRecoveries: [], failedDispatches: [], groupResults: [],
      activeGroupId: null, haltReason: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BREEZE_SERVER;
    process.env.PUBLIC_API_URL = 'https://breeze.example.test/';
    bmrMocks.resolveLatestRestorableSnapshotId.mockImplementation(async (_org: string, deviceId: string) =>
      deviceId === DEVICE_ID ? SNAP_1 : SNAP_2);
    let n = 0;
    bmrMocks.createBareMetalRecovery.mockImplementation(async (input: any) => {
      n += 1;
      const id = n === 1 ? REC_1 : REC_2;
      const deviceId = input.snapshotId === SNAP_1 ? DEVICE_ID : DEVICE_2;
      return { row: recoveryRow(id, deviceId, 'created', { identity: input.identity, executingDeviceId: input.executingDeviceId ?? null }), code: 'AAA-BBB-CCC' };
    });
    bmrMocks.mintRecoveryTokenForRecovery.mockImplementation(async ({ recoveryId }: any) => ({ token: `tok-${recoveryId}`, tokenId: `tid-${recoveryId}` }));
    bmrMocks.queueBareMetalRebuild.mockImplementation(async ({ payload }: any) => ({ command: { id: `cmd-${payload.recoveryId}`, status: 'sent' }, error: null }));
    bmrMocks.cancelBareMetalRecovery.mockResolvedValue({});
  });

  it('failover: one recovery per device with identity original, no device command, audited', async () => {
    const results = await dispatchGroup(execution('failover'), bmrGroup() as any, initialResults());

    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(bmrMocks.queueBareMetalRebuild).not.toHaveBeenCalled();
    expect(bmrMocks.mintRecoveryTokenForRecovery).not.toHaveBeenCalled();
    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(2);
    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, snapshotId: SNAP_1, identity: 'original', source: 'dr', createdBy: 'user-1',
      drExecutionId: EXECUTION_ID, drGroupId: GROUP_ID, executingDeviceId: null,
    }));
    expect(results.queuedRecoveries).toEqual([
      { groupId: GROUP_ID, groupName: 'Tier 1', deviceId: DEVICE_ID, recoveryId: REC_1, executingDeviceId: null, commandId: null, createdAt: T0.toISOString() },
      { groupId: GROUP_ID, groupName: 'Tier 1', deviceId: DEVICE_2, recoveryId: REC_2, executingDeviceId: null, commandId: null, createdAt: T0.toISOString() },
    ]);
    expect(results.queuedCommands).toEqual([]);
    expect(results.failedDispatches).toEqual([]);
    expect(results.dispatchStatus).toBe('running');
    expect(bmrMocks.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dr.step.bare_metal_rebuild.dispatch',
      orgId: ORG_ID,
      resourceId: EXECUTION_ID,
      details: expect.objectContaining({ groupId: GROUP_ID, executionType: 'failover', identity: 'original', recoveryIds: [REC_1, REC_2] }),
    }));
    // The audit entry never carries a code or a token.
    expect(JSON.stringify(bmrMocks.createAuditLogAsync.mock.calls)).not.toMatch(/AAA-BBB-CCC|tok-/);
  });

  it('failback also resumes the original identity', async () => {
    await dispatchGroup(execution('failback'), bmrGroup() as any, initialResults());
    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledWith(expect.objectContaining({ identity: 'original' }));
  });

  it('rehearsal: identity new on the host, one token + one bare_metal_rebuild per device to the HOST, commandId recorded', async () => {
    const results = await dispatchGroup(execution('rehearsal'), bmrGroup() as any, initialResults());

    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(2);
    for (const call of bmrMocks.createBareMetalRecovery.mock.calls) {
      expect(call[0]).toMatchObject({ identity: 'new', executingDeviceId: HOST_ID, source: 'dr' });
    }
    expect(bmrMocks.mintRecoveryTokenForRecovery).toHaveBeenCalledTimes(2);
    expect(bmrMocks.queueBareMetalRebuild).toHaveBeenCalledTimes(2);
    expect(bmrMocks.queueBareMetalRebuild).toHaveBeenCalledWith({
      orgId: ORG_ID,
      hostDeviceId: HOST_ID,
      userId: 'user-1',
      payload: {
        recoveryId: REC_1,
        token: `tok-${REC_1}`,
        server: 'https://breeze.example.test',
        target: { kind: 'vhdx', path: `/srv/rebuild/out/${DEVICE_ID}-${REC_1}.vhdx` },
        identity: 'new',
      },
    });
    expect(queueCommandForExecution).not.toHaveBeenCalled();
    expect(results.queuedRecoveries).toEqual([
      expect.objectContaining({ deviceId: DEVICE_ID, recoveryId: REC_1, executingDeviceId: HOST_ID, commandId: `cmd-${REC_1}` }),
      expect.objectContaining({ deviceId: DEVICE_2, recoveryId: REC_2, executingDeviceId: HOST_ID, commandId: `cmd-${REC_2}` }),
    ]);
    // The rehearsal command is NOT a DR command entry: results fold from the recovery row.
    expect(results.queuedCommands).toEqual([]);
  });

  it('rehearsal without a rebuild host fails the group with rebuild_host_required and creates nothing', async () => {
    const results = await dispatchGroup(execution('rehearsal'), bmrGroup({ restoreConfig: { commandType: 'BARE_METAL_REBUILD' } }) as any, initialResults());

    expect(bmrMocks.createBareMetalRecovery).not.toHaveBeenCalled();
    expect(results.failedDispatches).toEqual([
      expect.objectContaining({ groupId: GROUP_ID, commandType: 'BARE_METAL_REBUILD', error: 'rebuild_host_required' }),
    ]);
    expect(results.dispatchStatus).toBe('failed');
  });

  it('rehearsal with no server URL configured fails dispatch cleanly before creating a recovery', async () => {
    delete process.env.PUBLIC_API_URL;
    const results = await dispatchGroup(execution('rehearsal'), bmrGroup() as any, initialResults());

    expect(bmrMocks.createBareMetalRecovery).not.toHaveBeenCalled();
    expect(results.failedDispatches[0]?.error).toBe('server_url_unset');
    expect(results.dispatchStatus).toBe('failed');
  });

  it('rehearsal: a queue failure cancels the recovery (frees the per-device slot) and records the dispatch failure', async () => {
    bmrMocks.queueBareMetalRebuild
      .mockResolvedValueOnce({ command: { id: `cmd-${REC_1}`, status: 'sent' }, error: null })
      .mockResolvedValueOnce({ command: null, error: 'Device is offline, cannot execute command' });

    const results = await dispatchGroup(execution('rehearsal'), bmrGroup() as any, initialResults());

    expect(bmrMocks.cancelBareMetalRecovery).toHaveBeenCalledWith(expect.objectContaining({ recoveryId: REC_2, orgId: ORG_ID }));
    expect(results.queuedRecoveries.map((r) => r.recoveryId)).toEqual([REC_1]);
    expect(results.failedDispatches).toEqual([
      expect.objectContaining({ deviceId: DEVICE_2, error: 'Device is offline, cannot execute command' }),
    ]);
    expect(results.dispatchStatus).toBe('partial');
  });

  it('dispatching again with the same results creates nothing (dedupe on queuedRecoveries by group+device)', async () => {
    const first = await dispatchGroup(execution('failover'), bmrGroup() as any, initialResults());
    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(2);

    const second = await dispatchGroup(execution('failover'), bmrGroup() as any, first);

    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(2);
    expect(second.queuedRecoveries).toHaveLength(2);
  });

  it('a recovery_in_progress service error becomes a failedDispatches entry, not a throw', async () => {
    bmrMocks.createBareMetalRecovery.mockReset();
    bmrMocks.createBareMetalRecovery
      .mockResolvedValueOnce({ row: recoveryRow(REC_1, DEVICE_ID, 'created'), code: 'AAA-BBB-CCC' })
      .mockRejectedValueOnce(new BareMetalRecoveryError('recovery_in_progress', 409, { recoveryId: 'other' }));

    const results = await dispatchGroup(execution('failover'), bmrGroup() as any, initialResults());

    expect(results.queuedRecoveries.map((r) => r.deviceId)).toEqual([DEVICE_ID]);
    expect(results.failedDispatches).toEqual([
      expect.objectContaining({ groupId: GROUP_ID, deviceId: DEVICE_2, commandType: 'BARE_METAL_REBUILD', error: 'recovery_in_progress' }),
    ]);
    expect(results.dispatchStatus).toBe('partial');
  });

  it('a device with no restorable snapshot at dispatch time is a failedDispatches entry', async () => {
    bmrMocks.resolveLatestRestorableSnapshotId.mockImplementation(async (_o: string, d: string) => (d === DEVICE_ID ? SNAP_1 : null));

    const results = await dispatchGroup(execution('failover'), bmrGroup() as any, initialResults());

    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(1);
    expect(results.failedDispatches).toEqual([
      expect.objectContaining({ deviceId: DEVICE_2, error: 'no_restorable_snapshot' }),
    ]);
  });

  describe('computeGroupResults from recovery rows', () => {
    const queued = [
      { groupId: GROUP_ID, groupName: 'Tier 1', deviceId: DEVICE_ID, recoveryId: REC_1, executingDeviceId: null, commandId: null, createdAt: T0.toISOString() },
      { groupId: GROUP_ID, groupName: 'Tier 1', deviceId: DEVICE_2, recoveryId: REC_2, executingDeviceId: null, commandId: null, createdAt: T0.toISOString() },
    ];
    const tenMinutesLater = new Date(T0.getTime() + 10 * 60_000);

    function compute(rows: any[], now = tenMinutesLater) {
      return computeGroupResults([bmrGroup() as any], [], queued, [], new Map(), new Map(rows.map((r) => [r.id, r])), now);
    }

    it.each([
      ['checked_in', 'completed'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['refused', 'failed'],
      ['created', 'running'],
      ['media_booted', 'running'],
      ['restoring', 'running'],
      ['validated', 'running'],
      ['rebooted', 'running'],
    ])('recovery %s -> device %s', (recoveryStatus, expected) => {
      const [group] = compute([recoveryRow(REC_1, DEVICE_ID, recoveryStatus), recoveryRow(REC_2, DEVICE_2, 'restoring')]);
      const device = group!.devices.find((d) => d.id === DEVICE_ID)!;
      expect(device.status).toBe(expected);
      expect(device).toMatchObject({ recoveryId: REC_1, recoveryStatus, commandType: 'BARE_METAL_REBUILD' });
    });

    it('refused carries the refusal reason as the error', () => {
      const [group] = compute([recoveryRow(REC_1, DEVICE_ID, 'refused', { failureReason: 'disk too small' }), recoveryRow(REC_2, DEVICE_2, 'restoring')]);
      expect(group!.devices[0]).toMatchObject({ status: 'failed', error: 'disk too small' });
      expect(group!.status).toBe('running');
    });

    it('a created recovery older than waitTimeoutMinutes fails with reason timeout', () => {
      const late = new Date(T0.getTime() + 61 * 60_000);
      const [group] = compute([recoveryRow(REC_1, DEVICE_ID, 'created'), recoveryRow(REC_2, DEVICE_2, 'checked_in', { checkedInAt: tenMinutesLater })], late);
      expect(group!.devices[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
      expect(group!.devices[1]).toMatchObject({ status: 'completed' });
      expect(group!.status).toBe('failed');
    });

    it('a terminal recovery is never re-flagged as a timeout', () => {
      const late = new Date(T0.getTime() + 61 * 60_000);
      const [group] = compute([recoveryRow(REC_1, DEVICE_ID, 'checked_in', { checkedInAt: tenMinutesLater }), recoveryRow(REC_2, DEVICE_2, 'completed', { completedAt: tenMinutesLater })], late);
      expect(group!.status).toBe('completed');
      expect(group!.devices.every((d) => d.reason === undefined)).toBe(true);
      expect(group!.startedAt).toBe(T0.toISOString());
      expect(group!.completedAt).toBe(tenMinutesLater.toISOString());
    });

    it('group completes when every device checked in', () => {
      const [group] = compute([recoveryRow(REC_1, DEVICE_ID, 'checked_in'), recoveryRow(REC_2, DEVICE_2, 'completed')]);
      expect(group!.status).toBe('completed');
    });
  });

  it('three reconcile ticks create exactly N recoveries for N devices, then advance without a re-dispatch storm', async () => {
    // Tick 1: fresh execution → dispatch (2 recoveries).
    let persisted: any = null;
    vi.mocked(db.update).mockImplementation(() => {
      const chain: any = {};
      chain.set = vi.fn((values: any) => { persisted = values; return chain; });
      chain.where = vi.fn(() => chain);
      chain.returning = vi.fn(() => Promise.resolve([{ ...execution('failover', persisted.results), status: persisted.status }]));
      return chain;
    });
    vi.mocked(db.select)
      .mockImplementationOnce(() => createQueryChain([execution('failover')]) as any)
      .mockImplementationOnce(() => createQueryChain([bmrGroup()]) as any);

    const tick1 = await reconcileDrExecution(EXECUTION_ID);
    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(2);
    expect(tick1.execution?.status).toBe('running');
    expect(persisted.results.queuedRecoveries).toHaveLength(2);
    expect(persisted.results.queuedCommands).toEqual([]);

    // Tick 2: both still restoring → running, no new recoveries, recovery rows loaded by dr_execution_id.
    const afterTick1 = execution('failover', persisted.results);
    vi.mocked(db.select)
      .mockImplementationOnce(() => createQueryChain([afterTick1]) as any)
      .mockImplementationOnce(() => createQueryChain([bmrGroup()]) as any)
      .mockImplementationOnce(() => createQueryChain([recoveryRow(REC_1, DEVICE_ID, 'restoring'), recoveryRow(REC_2, DEVICE_2, 'media_booted')]) as any);

    const tick2 = await reconcileDrExecution(EXECUTION_ID);
    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(2);
    expect(tick2.execution?.status).toBe('running');
    expect(tick2.nextDelayMs).toBe(10_000);
    expect(persisted.results.groupResults[0].devices.map((d: any) => d.status)).toEqual(['running', 'running']);

    // Tick 3: both checked in → completed. Still exactly 2 recoveries ever created.
    const afterTick2 = execution('failover', persisted.results);
    vi.mocked(db.select)
      .mockImplementationOnce(() => createQueryChain([afterTick2]) as any)
      .mockImplementationOnce(() => createQueryChain([bmrGroup()]) as any)
      .mockImplementationOnce(() => createQueryChain([recoveryRow(REC_1, DEVICE_ID, 'checked_in'), recoveryRow(REC_2, DEVICE_2, 'checked_in')]) as any);

    const tick3 = await reconcileDrExecution(EXECUTION_ID);
    expect(bmrMocks.createBareMetalRecovery).toHaveBeenCalledTimes(2);
    expect(tick3.execution?.status).toBe('completed');
    expect(tick3.nextDelayMs).toBeNull();
    expect(persisted.results.dispatchStatus).toBe('completed');
    expect(bmrMocks.cancelBareMetalRecovery).not.toHaveBeenCalled();
  });

  it('reconcile cancels a timed-out recovery (reason timeout) so the row is terminal too', async () => {
    let persisted: any = null;
    vi.mocked(db.update).mockImplementation(() => {
      const chain: any = {};
      chain.set = vi.fn((values: any) => { persisted = values; return chain; });
      chain.where = vi.fn(() => chain);
      chain.returning = vi.fn(() => Promise.resolve([{ ...execution('failover', persisted.results), status: persisted.status }]));
      return chain;
    });
    const queuedResults = {
      ...initialResults(),
      dispatchStatus: 'running',
      queuedRecoveries: [
        { groupId: GROUP_ID, groupName: 'Tier 1', deviceId: DEVICE_ID, recoveryId: REC_1, executingDeviceId: null, commandId: null, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
        { groupId: GROUP_ID, groupName: 'Tier 1', deviceId: DEVICE_2, recoveryId: REC_2, executingDeviceId: null, commandId: null, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
      ],
    };
    const old = new Date(Date.now() - 2 * 3600_000);
    vi.mocked(db.select)
      .mockImplementationOnce(() => createQueryChain([execution('failover', queuedResults)]) as any)
      .mockImplementationOnce(() => createQueryChain([bmrGroup()]) as any)
      .mockImplementationOnce(() => createQueryChain([
        recoveryRow(REC_1, DEVICE_ID, 'created', { createdAt: old }),
        recoveryRow(REC_2, DEVICE_2, 'checked_in', { createdAt: old, checkedInAt: new Date() }),
      ]) as any);

    const outcome = await reconcileDrExecution(EXECUTION_ID);

    expect(bmrMocks.cancelBareMetalRecovery).toHaveBeenCalledTimes(1);
    expect(bmrMocks.cancelBareMetalRecovery).toHaveBeenCalledWith({ recoveryId: REC_1, orgId: ORG_ID, userId: null, reason: 'timeout' });
    expect(bmrMocks.createBareMetalRecovery).not.toHaveBeenCalled();
    expect(outcome.execution?.status).toBe('failed');
    expect(persisted.results.groupResults[0].devices[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
  });
});

// ── #3653 ───────────────────────────────────────────────────────────────────
// The DR execute route previously let these escape to the global Hono handler,
// which renders every non-HTTPException as a 500. The site barrier still held
// (it throws before the execution row is written) but the caller was told the
// server had broken, and every denial raised a Sentry event.
describe('classifyDrExecutionAuthorizationError', () => {
  it('carries a resilience denial status and code through unchanged', () => {
    expect(classifyDrExecutionAuthorizationError(
      new ResilienceAuthorizationError(403, 'site_access_denied'),
    )).toEqual({ status: 403, code: 'site_access_denied' });

    expect(classifyDrExecutionAuthorizationError(
      new ResilienceAuthorizationError(404, 'resource_not_found'),
    )).toEqual({ status: 404, code: 'resource_not_found' });
  });

  it('reports a recovery-subject denial as 403', () => {
    expect(classifyDrExecutionAuthorizationError(
      new RecoveryAuthorizationDeniedError('base_permission_denied'),
    )).toEqual({ status: 403, code: 'base_permission_denied' });
  });

  it('reports an unavailable authorization dependency as 503, not a denial', () => {
    expect(classifyDrExecutionAuthorizationError(
      new RecoveryAuthorizationTransientError('authorization_dependency_unavailable'),
    )).toEqual({ status: 503, code: 'authorization_dependency_unavailable' });
  });

  it('separates an unresolvable plan reference from a site denial', () => {
    expect(classifyDrExecutionAuthorizationError(
      new DrRecoveryAuthorizationDeniedError('resource_not_found'),
    )).toEqual({ status: 404, code: 'resource_not_found' });

    expect(classifyDrExecutionAuthorizationError(
      new DrRecoveryAuthorizationDeniedError('ambiguous_snapshot_reference'),
    )).toEqual({ status: 400, code: 'ambiguous_snapshot_reference' });
  });

  it('returns null for anything else so real faults keep propagating', () => {
    expect(classifyDrExecutionAuthorizationError(new Error('redis is on fire'))).toBeNull();
    expect(classifyDrExecutionAuthorizationError('nope')).toBeNull();
    expect(classifyDrExecutionAuthorizationError(undefined)).toBeNull();
  });
});
