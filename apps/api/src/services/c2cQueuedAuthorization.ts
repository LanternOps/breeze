import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  backupConfigs,
  c2cBackupConfigs,
  c2cBackupItems,
  c2cBackupJobs,
  c2cConnections,
} from '../db/schema';
import type { ProcessRestoreData, RunSyncData } from '../jobs/c2cEnqueue';
import {
  authorizeQueuedRecoveryWork,
  RecoveryAuthorizationDeniedError,
  type RecoveryAuthorizationIntent,
  type RecoveryAuthorizationState,
  type RecoveryAuthorizationSubjectRow,
} from './recoveryAuthorizationSubject';

const { db } = dbModule;

export type C2cQueuedWorkData = RunSyncData | ProcessRestoreData;

export interface C2cQueuedAuthorizationJob extends RecoveryAuthorizationSubjectRow {
  id: string;
  orgId: string;
  configId: string;
  status: string;
  operationKind: 'sync' | 'restore' | 'unknown';
}

type C2cConfigLineage = {
  id: string;
  orgId: string;
  connectionId: string;
  storageConfigId: string | null;
  isActive: boolean;
};

type OwnedId = { id: string; orgId: string };
type OwnedItem = OwnedId & { configId: string };

export interface C2cQueuedAuthorizationDependencies {
  now(): Date;
  loadJob(id: string): Promise<C2cQueuedAuthorizationJob | null>;
  loadConfig(id: string): Promise<C2cConfigLineage | null>;
  loadConnection(id: string): Promise<OwnedId | null>;
  loadStorageConfig(id: string): Promise<OwnedId | null>;
  loadItems(ids: string[]): Promise<OwnedItem[]>;
  authorizeQueuedRecoveryWork: typeof authorizeQueuedRecoveryWork;
  claimSync(job: C2cQueuedAuthorizationJob, checkedAt: Date): Promise<boolean>;
  failSyncNotImplemented(job: C2cQueuedAuthorizationJob, checkedAt: Date): Promise<void>;
  failRestoreNotImplemented(
    job: C2cQueuedAuthorizationJob,
    itemCount: number,
    checkedAt: Date,
  ): Promise<boolean>;
  recordDenial(
    job: C2cQueuedAuthorizationJob,
    state: Extract<RecoveryAuthorizationState, 'denied' | 'quarantined_authorization_unknown'>,
    code: string,
    checkedAt: Date,
  ): Promise<boolean>;
}

class C2cLineageDeniedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'C2cLineageDeniedError';
  }
}

function queuedJobId(data: C2cQueuedWorkData): string {
  return data.type === 'run-sync' ? data.jobId : data.restoreJobId;
}

function queuedKind(data: C2cQueuedWorkData): 'sync' | 'restore' {
  return data.type === 'run-sync' ? 'sync' : 'restore';
}

function intentFor(kind: 'sync' | 'restore'): RecoveryAuthorizationIntent {
  return kind === 'sync'
    ? { operation: 'c2c_sync', requiredAiTool: 'trigger_c2c_sync' }
    : { operation: 'c2c_restore', requiredAiTool: 'restore_c2c_items' };
}

async function requireCurrentOwnerLineage(
  data: C2cQueuedWorkData,
  job: C2cQueuedAuthorizationJob,
  deps: C2cQueuedAuthorizationDependencies,
): Promise<number> {
  const config = await deps.loadConfig(job.configId);
  if (!config || config.id !== job.configId || config.orgId !== job.orgId) {
    throw new C2cLineageDeniedError('c2c_config_owner_mismatch');
  }
  if (data.type === 'run-sync' && !config.isActive) {
    throw new C2cLineageDeniedError('c2c_sync_config_inactive');
  }

  const source = await deps.loadConnection(config.connectionId);
  if (!source || source.orgId !== job.orgId) {
    throw new C2cLineageDeniedError('c2c_source_connection_owner_mismatch');
  }

  if (config.storageConfigId) {
    const storage = await deps.loadStorageConfig(config.storageConfigId);
    if (!storage || storage.orgId !== job.orgId) {
      throw new C2cLineageDeniedError('c2c_storage_config_owner_mismatch');
    }
  }

  if (data.type === 'run-sync') return 0;

  const uniqueItemIds = [...new Set(data.itemIds)];
  if (uniqueItemIds.length === 0) {
    throw new C2cLineageDeniedError('c2c_restore_items_missing');
  }
  const items = await deps.loadItems(uniqueItemIds);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  if (uniqueItemIds.some((id) => {
    const item = itemsById.get(id);
    return !item || item.orgId !== job.orgId || item.configId !== job.configId;
  })) {
    throw new C2cLineageDeniedError('c2c_restore_item_owner_mismatch');
  }

  if (data.targetConnectionId) {
    const target = await deps.loadConnection(data.targetConnectionId);
    if (!target || target.orgId !== job.orgId) {
      throw new C2cLineageDeniedError('c2c_target_connection_owner_mismatch');
    }
  }
  return uniqueItemIds.length;
}

export async function authorizeAndFinalizeC2cQueuedWork(
  data: C2cQueuedWorkData,
  deps: C2cQueuedAuthorizationDependencies = defaultC2cQueuedAuthorizationDependencies,
): Promise<{ synced: boolean; skipped?: boolean; reason?: string } | { restored: boolean; skipped?: boolean; reason?: string }> {
  const job = await deps.loadJob(queuedJobId(data));
  if (!job || job.status !== 'pending') {
    return data.type === 'run-sync'
      ? { synced: false, skipped: true, reason: 'c2c_job_not_pending' }
      : { restored: false, skipped: true, reason: 'c2c_job_not_pending' };
  }

  const checkedAt = deps.now();
  const expectedKind = queuedKind(data);
  const queueBindingMatches = job.orgId === data.orgId
    && (data.type !== 'run-sync' || job.configId === data.configId);

  if (job.authorizationState === 'denied' || job.authorizationState === 'not_required') {
    return data.type === 'run-sync'
      ? { synced: false, skipped: true, reason: 'c2c_authorization_not_pending' }
      : { restored: false, skipped: true, reason: 'c2c_authorization_not_pending' };
  }

  if (
    job.authorizationState === 'quarantined_authorization_unknown'
    || job.operationKind === 'unknown'
    || job.authorizationPrincipalKind === 'unknown'
  ) {
    await deps.recordDenial(
      job,
      'quarantined_authorization_unknown',
      'quarantined_authorization_unknown',
      checkedAt,
    );
    return data.type === 'run-sync'
      ? { synced: false, skipped: true, reason: 'quarantined_authorization_unknown' }
      : { restored: false, skipped: true, reason: 'quarantined_authorization_unknown' };
  }

  const deny = async (code: string) => {
    await deps.recordDenial(job, 'denied', code, checkedAt);
    return data.type === 'run-sync'
      ? { synced: false, skipped: true as const, reason: code }
      : { restored: false, skipped: true as const, reason: code };
  };

  if (!queueBindingMatches) return deny('c2c_queue_binding_mismatch');
  if (job.operationKind !== expectedKind) return deny('c2c_operation_kind_mismatch');

  try {
    await deps.authorizeQueuedRecoveryWork(job, job.orgId, [], intentFor(expectedKind));
    const itemCount = await requireCurrentOwnerLineage(data, job, deps);

    if (data.type === 'process-restore') {
      const finalized = await deps.failRestoreNotImplemented(job, itemCount, checkedAt);
      return finalized
        ? { restored: false }
        : { restored: false, skipped: true, reason: 'c2c_job_claim_conflict' };
    }

    const claimed = await deps.claimSync(job, checkedAt);
    if (!claimed) return { synced: false, skipped: true, reason: 'c2c_job_claim_conflict' };
    await deps.failSyncNotImplemented(job, checkedAt);
    return { synced: false };
  } catch (error) {
    if (error instanceof RecoveryAuthorizationDeniedError || error instanceof C2cLineageDeniedError) {
      return deny(error.code);
    }
    throw error;
  }
}

function subjectCas(job: C2cQueuedAuthorizationJob) {
  return [
    eq(c2cBackupJobs.authorizationPrincipalKind, job.authorizationPrincipalKind),
    job.authorizationPrincipalId === null
      ? isNull(c2cBackupJobs.authorizationPrincipalId)
      : eq(c2cBackupJobs.authorizationPrincipalId, job.authorizationPrincipalId),
    job.authorizationGrantRevision === null
      ? isNull(c2cBackupJobs.authorizationGrantRevision)
      : eq(c2cBackupJobs.authorizationGrantRevision, job.authorizationGrantRevision),
  ];
}

export const defaultC2cQueuedAuthorizationDependencies: C2cQueuedAuthorizationDependencies = {
  now: () => new Date(),
  async loadJob(id) {
    const [row] = await db.select({
      id: c2cBackupJobs.id,
      orgId: c2cBackupJobs.orgId,
      configId: c2cBackupJobs.configId,
      status: c2cBackupJobs.status,
      operationKind: c2cBackupJobs.operationKind,
      authorizationPrincipalKind: c2cBackupJobs.authorizationPrincipalKind,
      authorizationPrincipalId: c2cBackupJobs.authorizationPrincipalId,
      authorizationGrantRevision: c2cBackupJobs.authorizationGrantRevision,
      authorizationState: c2cBackupJobs.authorizationState,
      authorizationDenialCode: c2cBackupJobs.authorizationDenialCode,
      authorizationCheckedAt: c2cBackupJobs.authorizationCheckedAt,
    }).from(c2cBackupJobs).where(eq(c2cBackupJobs.id, id)).limit(1);
    return row ?? null;
  },
  async loadConfig(id) {
    const [row] = await db.select({
      id: c2cBackupConfigs.id,
      orgId: c2cBackupConfigs.orgId,
      connectionId: c2cBackupConfigs.connectionId,
      storageConfigId: c2cBackupConfigs.storageConfigId,
      isActive: c2cBackupConfigs.isActive,
    }).from(c2cBackupConfigs).where(eq(c2cBackupConfigs.id, id)).limit(1);
    return row ?? null;
  },
  async loadConnection(id) {
    const [row] = await db.select({ id: c2cConnections.id, orgId: c2cConnections.orgId })
      .from(c2cConnections).where(eq(c2cConnections.id, id)).limit(1);
    return row ?? null;
  },
  async loadStorageConfig(id) {
    const [row] = await db.select({ id: backupConfigs.id, orgId: backupConfigs.orgId })
      .from(backupConfigs).where(eq(backupConfigs.id, id)).limit(1);
    return row ?? null;
  },
  async loadItems(ids) {
    return db.select({
      id: c2cBackupItems.id,
      orgId: c2cBackupItems.orgId,
      configId: c2cBackupItems.configId,
    }).from(c2cBackupItems).where(inArray(c2cBackupItems.id, ids));
  },
  authorizeQueuedRecoveryWork,
  async claimSync(job, checkedAt) {
    const rows = await db.update(c2cBackupJobs).set({
      status: 'running',
      startedAt: checkedAt,
      authorizationState: 'authorized',
      authorizationDenialCode: null,
      authorizationCheckedAt: checkedAt,
      updatedAt: checkedAt,
    }).where(and(
      eq(c2cBackupJobs.id, job.id),
      eq(c2cBackupJobs.orgId, job.orgId),
      eq(c2cBackupJobs.configId, job.configId),
      eq(c2cBackupJobs.status, 'pending'),
      eq(c2cBackupJobs.operationKind, 'sync'),
      ...subjectCas(job),
    )).returning({ id: c2cBackupJobs.id });
    return rows.length === 1;
  },
  async failSyncNotImplemented(job, checkedAt) {
    await db.update(c2cBackupJobs).set({
      status: 'failed',
      completedAt: checkedAt,
      errorLog: 'c2c_sync_not_implemented',
      updatedAt: checkedAt,
    }).where(and(
      eq(c2cBackupJobs.id, job.id),
      eq(c2cBackupJobs.orgId, job.orgId),
      eq(c2cBackupJobs.configId, job.configId),
      eq(c2cBackupJobs.status, 'running'),
      eq(c2cBackupJobs.operationKind, 'sync'),
      ...subjectCas(job),
    ));
  },
  async failRestoreNotImplemented(job, itemCount, checkedAt) {
    const rows = await db.update(c2cBackupJobs).set({
      status: 'failed',
      completedAt: checkedAt,
      itemsProcessed: itemCount,
      errorLog: 'c2c_restore_not_implemented',
      authorizationState: 'authorized',
      authorizationDenialCode: null,
      authorizationCheckedAt: checkedAt,
      updatedAt: checkedAt,
    }).where(and(
      eq(c2cBackupJobs.id, job.id),
      eq(c2cBackupJobs.orgId, job.orgId),
      eq(c2cBackupJobs.configId, job.configId),
      eq(c2cBackupJobs.status, 'pending'),
      eq(c2cBackupJobs.operationKind, 'restore'),
      ...subjectCas(job),
    )).returning({ id: c2cBackupJobs.id });
    return rows.length === 1;
  },
  async recordDenial(job, state, code, checkedAt) {
    const rows = await db.update(c2cBackupJobs).set({
      authorizationState: state,
      authorizationDenialCode: code,
      authorizationCheckedAt: checkedAt,
      updatedAt: checkedAt,
    }).where(and(
      eq(c2cBackupJobs.id, job.id),
      eq(c2cBackupJobs.status, 'pending'),
      ...subjectCas(job),
    )).returning({ id: c2cBackupJobs.id });
    return rows.length === 1;
  },
};
