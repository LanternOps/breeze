import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeAndFinalizeC2cQueuedWork,
  type C2cQueuedAuthorizationDependencies,
  type C2cQueuedAuthorizationJob,
} from './c2cQueuedAuthorization';
import { RecoveryAuthorizationDeniedError } from './recoveryAuthorizationSubject';

const baseJob: C2cQueuedAuthorizationJob = {
  id: 'job-1',
  orgId: 'org-1',
  configId: 'config-1',
  status: 'pending',
  operationKind: 'sync',
  authorizationPrincipalKind: 'user_session',
  authorizationPrincipalId: 'user-1',
  authorizationGrantRevision: 'rev-1',
  authorizationState: 'pending',
  authorizationDenialCode: null,
  authorizationCheckedAt: null,
};

function dependencies(
  overrides: Partial<C2cQueuedAuthorizationDependencies> = {},
): C2cQueuedAuthorizationDependencies {
  return {
    now: () => new Date('2026-08-24T12:00:00.000Z'),
    loadJob: vi.fn(async () => baseJob),
    loadConfig: vi.fn(async () => ({
      id: 'config-1',
      orgId: 'org-1',
      connectionId: 'source-1',
      storageConfigId: 'storage-1',
      isActive: true,
    })),
    loadConnection: vi.fn(async (id: string) => ({ id, orgId: 'org-1' })),
    loadStorageConfig: vi.fn(async (id: string) => ({ id, orgId: 'org-1' })),
    loadItems: vi.fn(async (ids: string[]) => ids.map((id) => ({
      id,
      orgId: 'org-1',
      configId: 'config-1',
    }))),
    authorizeQueuedRecoveryWork: vi.fn(async () => ({ subject: {}, resources: { resources: [] } }) as never),
    claimSync: vi.fn(async () => true),
    failSyncNotImplemented: vi.fn(async () => undefined),
    failRestoreNotImplemented: vi.fn(async () => true),
    recordDenial: vi.fn(async () => true),
    ...overrides,
  };
}

describe('C2C queued authorization boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('authorizes a pending sync against its durable kind and complete current owner lineage before claim', async () => {
    const deps = dependencies();

    const result = await authorizeAndFinalizeC2cQueuedWork({
      type: 'run-sync',
      jobId: 'job-1',
      configId: 'config-1',
      orgId: 'org-1',
    }, deps);

    expect(result).toEqual({ synced: false });
    expect(deps.authorizeQueuedRecoveryWork).toHaveBeenCalledWith(
      baseJob,
      'org-1',
      [],
      expect.objectContaining({ operation: 'c2c_sync', requiredAiTool: 'trigger_c2c_sync' }),
    );
    expect(deps.claimSync).toHaveBeenCalledOnce();
    expect(deps.failSyncNotImplemented).toHaveBeenCalledOnce();
    expect(deps.failRestoreNotImplemented).not.toHaveBeenCalled();
  });

  it.each([
    ['config', { loadConfig: vi.fn(async () => ({ ...await dependencies().loadConfig('config-1'), orgId: 'org-2' })) }],
    ['source connection', { loadConnection: vi.fn(async () => ({ id: 'source-1', orgId: 'org-2' })) }],
    ['storage config', { loadStorageConfig: vi.fn(async () => ({ id: 'storage-1', orgId: 'org-2' })) }],
  ])('denies sync when current %s ownership changed without claiming', async (_label, override) => {
    const deps = dependencies(override as Partial<C2cQueuedAuthorizationDependencies>);

    const result = await authorizeAndFinalizeC2cQueuedWork({
      type: 'run-sync', jobId: 'job-1', configId: 'config-1', orgId: 'org-1',
    }, deps);

    expect(result).toEqual(expect.objectContaining({ skipped: true }));
    expect(deps.recordDenial).toHaveBeenCalledOnce();
    expect(deps.claimSync).not.toHaveBeenCalled();
    expect(deps.failRestoreNotImplemented).not.toHaveBeenCalled();
  });

  it.each(['user_session', 'api_key', 'oauth_grant', 'ai_agent'] as const)(
    'persists a known %s revocation before any operational claim',
    async (authorizationPrincipalKind) => {
      const job = { ...baseJob, authorizationPrincipalKind };
      const deps = dependencies({
        loadJob: vi.fn(async () => job),
        authorizeQueuedRecoveryWork: vi.fn(async () => {
          throw new RecoveryAuthorizationDeniedError('principal_inactive');
        }),
      });

      const result = await authorizeAndFinalizeC2cQueuedWork({
        type: 'run-sync', jobId: 'job-1', configId: 'config-1', orgId: 'org-1',
      }, deps);

      expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'principal_inactive' }));
      expect(deps.recordDenial).toHaveBeenCalledWith(
        job,
        'denied',
        'principal_inactive',
        new Date('2026-08-24T12:00:00.000Z'),
      );
      expect(deps.claimSync).not.toHaveBeenCalled();
    },
  );

  it('leaves transient authorization failures pending and retriable', async () => {
    const deps = dependencies({
      authorizeQueuedRecoveryWork: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });

    await expect(authorizeAndFinalizeC2cQueuedWork({
      type: 'run-sync', jobId: 'job-1', configId: 'config-1', orgId: 'org-1',
    }, deps)).rejects.toThrow('database unavailable');
    expect(deps.recordDenial).not.toHaveBeenCalled();
    expect(deps.claimSync).not.toHaveBeenCalled();
  });

  it('quarantines legacy unknown work and rejects a queue/stored kind mismatch', async () => {
    const unknown = { ...baseJob, operationKind: 'unknown' as const, authorizationPrincipalKind: 'unknown' as const };
    const deps = dependencies({ loadJob: vi.fn(async () => unknown) });

    await authorizeAndFinalizeC2cQueuedWork({
      type: 'run-sync', jobId: 'job-1', configId: 'config-1', orgId: 'org-1',
    }, deps);

    expect(deps.recordDenial).toHaveBeenCalledWith(
      unknown,
      'quarantined_authorization_unknown',
      'quarantined_authorization_unknown',
      expect.any(Date),
    );
    expect(deps.authorizeQueuedRecoveryWork).not.toHaveBeenCalled();
    expect(deps.claimSync).not.toHaveBeenCalled();
  });

  it.each(['denied', 'not_required'] as const)(
    'does not revive durable %s work on a replay',
    async (authorizationState) => {
      const job = { ...baseJob, authorizationState };
      const deps = dependencies({ loadJob: vi.fn(async () => job) });

      const result = await authorizeAndFinalizeC2cQueuedWork({
        type: 'run-sync', jobId: 'job-1', configId: 'config-1', orgId: 'org-1',
      }, deps);

      expect(result).toEqual({ synced: false, skipped: true, reason: 'c2c_authorization_not_pending' });
      expect(deps.authorizeQueuedRecoveryWork).not.toHaveBeenCalled();
      expect(deps.recordDenial).not.toHaveBeenCalled();
      expect(deps.claimSync).not.toHaveBeenCalled();
    },
  );

  it('deduplicates restore item IDs, requires every item and target owner, and never claims running', async () => {
    const restoreJob = { ...baseJob, operationKind: 'restore' as const };
    const deps = dependencies({ loadJob: vi.fn(async () => restoreJob) });

    const result = await authorizeAndFinalizeC2cQueuedWork({
      type: 'process-restore',
      restoreJobId: 'job-1',
      orgId: 'org-1',
      itemIds: ['item-1', 'item-1', 'item-2'],
      targetConnectionId: 'target-1',
    }, deps);

    expect(deps.loadItems).toHaveBeenCalledWith(['item-1', 'item-2']);
    expect(deps.authorizeQueuedRecoveryWork).toHaveBeenCalledWith(
      restoreJob,
      'org-1',
      [],
      expect.objectContaining({ operation: 'c2c_restore', requiredAiTool: 'restore_c2c_items' }),
    );
    expect(deps.claimSync).not.toHaveBeenCalled();
    expect(deps.failRestoreNotImplemented).toHaveBeenCalledWith(
      restoreJob,
      2,
      new Date('2026-08-24T12:00:00.000Z'),
    );
    expect(result).toEqual({ restored: false });
  });

  it.each([
    ['missing item', { loadItems: vi.fn(async () => [{ id: 'item-1', orgId: 'org-1', configId: 'config-1' }]) }],
    ['moved item', { loadItems: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, orgId: 'org-2', configId: 'config-1' }))) }],
    ['moved target', { loadConnection: vi.fn(async (id: string) => ({ id, orgId: id === 'target-1' ? 'org-2' : 'org-1' })) }],
  ])('denies restore for a %s before finalization', async (_label, override) => {
    const deps = dependencies({
      loadJob: vi.fn(async () => ({ ...baseJob, operationKind: 'restore' as const })),
      ...(override as Partial<C2cQueuedAuthorizationDependencies>),
    });

    await authorizeAndFinalizeC2cQueuedWork({
      type: 'process-restore', restoreJobId: 'job-1', orgId: 'org-1',
      itemIds: ['item-1', 'item-2'], targetConnectionId: 'target-1',
    }, deps);

    expect(deps.recordDenial).toHaveBeenCalledOnce();
    expect(deps.claimSync).not.toHaveBeenCalled();
    expect(deps.failRestoreNotImplemented).not.toHaveBeenCalled();
  });
});
