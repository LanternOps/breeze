import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  backupJobs,
  backupSnapshotFiles,
  backupSnapshots,
  backupPolicies,
  configPolicyBackupSettings,
  backupConfigs,
} from '../db/schema';
import { backupChains } from '../db/schema/applicationBackup';
import {
  applyGfsTagsToSnapshot,
  computeExpiresAt,
  resolveGfsConfigForJob,
} from '../jobs/backupRetention';
import type { ParsedBackupCommandResult } from '../routes/backup/resultSchemas';
import {
  applyBackupSnapshotImmutability,
  checkBackupProviderCapabilities,
} from './backupSnapshotStorage';
import { resolveBackupProtectionForDevice } from './featureConfigResolver';

export const IN_FLIGHT_BACKUP_JOB_STATUSES = ['pending', 'running'] as const;
type SnapshotImmutabilityEnforcement = 'application' | 'provider';

type SnapshotProtectionSettings = {
  legalHold: boolean;
  legalHoldReason: string | null;
  isImmutable: boolean;
  immutableUntil: Date | null;
  immutabilityEnforcement: SnapshotImmutabilityEnforcement | null;
  requestedImmutabilityEnforcement: SnapshotImmutabilityEnforcement | null;
  legalHoldSource: 'policy' | 'manual' | null;
};

function normalizeMetadata(
  metadata: ParsedBackupCommandResult['metadata']
): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...metadata }
    : {};
}

function getStringValue(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getFirstStringValue(
  metadata: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = getStringValue(metadata, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function buildSnapshotLabel(
  metadata: Record<string, unknown>,
  timestamp: Date,
): string {
  const vmName = getStringValue(metadata, 'vmName');
  if (metadata.backupKind === 'hyperv_export' && vmName) {
    return `Hyper-V ${vmName} ${timestamp.toISOString().slice(0, 10)}`;
  }

  const database = getFirstStringValue(metadata, ['database', 'databaseName']);
  if ((metadata.backupKind === 'mssql_database' || metadata.backupKind === 'mssql_backup') && database) {
    const subtype = getFirstStringValue(metadata, ['backupSubtype', 'mssqlBackupType']);
    const suffix = subtype ? ` ${subtype}` : '';
    return `MSSQL ${database}${suffix} ${timestamp.toISOString().slice(0, 10)}`;
  }

  return `Backup ${timestamp.toISOString().slice(0, 10)}`;
}

function computeImmutableUntil(
  timestamp: Date,
  immutableDays: number | null,
): Date | null {
  if (!immutableDays || immutableDays < 1) {
    return null;
  }

  const immutableUntil = new Date(timestamp);
  immutableUntil.setUTCDate(immutableUntil.getUTCDate() + immutableDays);
  return immutableUntil;
}

function mergeSnapshotProtectionMetadata(
  metadata: Record<string, unknown>,
  updates: { legalHoldSource?: 'policy' | 'manual' | null },
): Record<string, unknown> {
  const currentProtection =
    metadata.snapshotProtection && typeof metadata.snapshotProtection === 'object' && !Array.isArray(metadata.snapshotProtection)
      ? { ...(metadata.snapshotProtection as Record<string, unknown>) }
      : {};

  const nextProtection = {
    ...currentProtection,
    ...(updates.legalHoldSource === undefined
      ? {}
      : updates.legalHoldSource === null
        ? { legalHoldSource: null }
        : { legalHoldSource: updates.legalHoldSource }),
  };

  return {
    ...metadata,
    snapshotProtection: nextProtection,
  };
}

async function resolveSnapshotProtectionSettingsForJob(
  jobId: string,
  timestamp: Date,
): Promise<SnapshotProtectionSettings> {
  const defaults: SnapshotProtectionSettings = {
    legalHold: false,
    legalHoldReason: null,
    isImmutable: false,
    immutableUntil: null,
    immutabilityEnforcement: null,
    requestedImmutabilityEnforcement: null,
    legalHoldSource: null,
  };

  const [job] = await db
    .select({
      featureLinkId: backupJobs.featureLinkId,
      policyId: backupJobs.policyId,
      deviceId: backupJobs.deviceId,
    })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);

  if (!job) {
    return defaults;
  }

  if (job.deviceId && job.featureLinkId) {
    const resolved = await resolveBackupProtectionForDevice(job.deviceId);
    if (resolved) {
      const immutableUntil = computeImmutableUntil(timestamp, resolved.immutableDays);
      return {
        legalHold: resolved.legalHold,
        legalHoldReason: resolved.legalHoldReason,
        isImmutable: resolved.immutabilityMode !== null && immutableUntil !== null,
        immutableUntil,
        immutabilityEnforcement: resolved.immutabilityMode,
        requestedImmutabilityEnforcement: resolved.immutabilityMode,
        legalHoldSource: resolved.legalHold ? 'policy' : null,
      };
    }
  }

  if (job.featureLinkId) {
    const [settings] = await db
      .select({
        retention: configPolicyBackupSettings.retention,
      })
      .from(configPolicyBackupSettings)
      .where(eq(configPolicyBackupSettings.featureLinkId, job.featureLinkId))
      .limit(1);

    const retention =
      settings?.retention && typeof settings.retention === 'object' && !Array.isArray(settings.retention)
        ? settings.retention as Record<string, unknown>
        : null;

    const legalHold = retention?.legalHold === true;
    const legalHoldReason =
      typeof retention?.legalHoldReason === 'string' && retention.legalHoldReason.trim().length > 0
        ? retention.legalHoldReason.trim()
        : null;
    const immutabilityMode =
      retention?.immutabilityMode === 'application' || retention?.immutabilityMode === 'provider'
        ? retention.immutabilityMode
        : null;
    const immutableDays =
      typeof retention?.immutableDays === 'number' && retention.immutableDays > 0
        ? retention.immutableDays
        : null;

    const immutableUntil =
      immutabilityMode === 'application' || immutabilityMode === 'provider'
        ? computeImmutableUntil(timestamp, immutableDays)
        : null;

    return {
      legalHold,
      legalHoldReason,
      isImmutable:
        (immutabilityMode === 'application' || immutabilityMode === 'provider') &&
        immutableUntil !== null,
      immutableUntil,
      immutabilityEnforcement: immutabilityMode,
      requestedImmutabilityEnforcement: immutabilityMode,
      legalHoldSource: legalHold ? 'policy' : null,
    };
  }

  if (job.policyId) {
    const [policy] = await db
      .select({
        legalHold: backupPolicies.legalHold,
        legalHoldReason: backupPolicies.legalHoldReason,
      })
      .from(backupPolicies)
      .where(eq(backupPolicies.id, job.policyId))
      .limit(1);

    return {
      ...defaults,
      legalHold: policy?.legalHold === true,
      legalHoldReason:
        typeof policy?.legalHoldReason === 'string' && policy.legalHoldReason.trim().length > 0
          ? policy.legalHoldReason.trim()
          : null,
      legalHoldSource: policy?.legalHold === true ? 'policy' : null,
    };
  }

  return defaults;
}

async function resolveBackupConfigStorage(
  configId: string | null,
): Promise<{ provider: string | null; providerConfig: unknown } | null> {
  if (!configId) return null;

  const [config] = await db
    .select({
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupConfigs)
    .where(eq(backupConfigs.id, configId))
    .limit(1);

  return config ?? null;
}

async function reconcileMssqlBackupChain(params: {
  orgId: string;
  deviceId: string;
  configId: string | null;
  snapshotDbId: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { orgId, deviceId, configId, snapshotDbId, timestamp, metadata } = params;

  if ((metadata.backupKind !== 'mssql_database' && metadata.backupKind !== 'mssql_backup') || !configId) {
    return;
  }

  const instance = getFirstStringValue(metadata, ['instance', 'instanceName']);
  const database = getFirstStringValue(metadata, ['database', 'databaseName']);
  const backupSubtype = getFirstStringValue(metadata, ['backupSubtype', 'mssqlBackupType']) ?? 'full';
  if (!instance || !database) {
    return;
  }

  const firstLsn = getStringValue(metadata, 'firstLsn');
  const lastLsn = getStringValue(metadata, 'lastLsn');
  const databaseBackupLsn = getStringValue(metadata, 'databaseBackupLsn');

  const [existingChain] = await db
    .select({
      id: backupChains.id,
      fullSnapshotId: backupChains.fullSnapshotId,
      chainMetadata: backupChains.chainMetadata,
    })
    .from(backupChains)
    .where(
      and(
        eq(backupChains.orgId, orgId),
        eq(backupChains.deviceId, deviceId),
        eq(backupChains.configId, configId),
        eq(backupChains.chainType, 'mssql'),
        eq(backupChains.targetName, database),
        eq(backupChains.targetId, instance)
      )
    )
    .limit(1);

  const existingMetadata =
    existingChain?.chainMetadata &&
    typeof existingChain.chainMetadata === 'object' &&
    !Array.isArray(existingChain.chainMetadata)
      ? { ...(existingChain.chainMetadata as Record<string, unknown>) }
      : {};

  const baseDatabaseBackupLsn =
    backupSubtype === 'full'
      ? databaseBackupLsn
      : getStringValue(existingMetadata, 'baseDatabaseBackupLsn');

  let health = 'active';
  let continuity = 'ok';
  let isActive = true;
  if (backupSubtype !== 'full') {
    if (!existingChain?.fullSnapshotId) {
      health = 'broken';
      continuity = 'missing_full_backup';
      isActive = false;
    } else if (
      baseDatabaseBackupLsn &&
      databaseBackupLsn &&
      baseDatabaseBackupLsn !== databaseBackupLsn
    ) {
      health = 'broken';
      continuity = 'database_backup_lsn_mismatch';
      isActive = false;
    }
  }

  const chainMetadata = {
    ...existingMetadata,
    health,
    continuity,
    instance,
    database,
    lastBackupAt: timestamp.toISOString(),
    lastBackupType: backupSubtype,
    lastFirstLsn: firstLsn,
    lastLastLsn: lastLsn,
    lastDatabaseBackupLsn: databaseBackupLsn,
    baseDatabaseBackupLsn,
    fullFirstLsn:
      backupSubtype === 'full'
        ? firstLsn
        : getStringValue(existingMetadata, 'fullFirstLsn'),
    fullLastLsn:
      backupSubtype === 'full'
        ? lastLsn
        : getStringValue(existingMetadata, 'fullLastLsn'),
  };

  const values = {
    orgId,
    deviceId,
    configId,
    chainType: 'mssql',
    targetName: database,
    targetId: instance,
    isActive,
    fullSnapshotId: backupSubtype === 'full' ? snapshotDbId : existingChain?.fullSnapshotId ?? null,
    chainMetadata,
    updatedAt: new Date(),
  };

  if (existingChain?.id) {
    await db
      .update(backupChains)
      .set(values)
      .where(eq(backupChains.id, existingChain.id));
    return;
  }

  await db.insert(backupChains).values({
    ...values,
    createdAt: new Date(),
  });
}

export async function applyBackupCommandResultToJob(params: {
  jobId: string;
  orgId: string;
  deviceId: string;
  resultStatus: string;
  result: ParsedBackupCommandResult & { error?: string };
}): Promise<{
  applied: boolean;
  snapshotDbId: string | null;
  providerSnapshotId: string | null;
}> {
  const { jobId, orgId, deviceId, resultStatus, result } = params;
  const providerSnapshotId = result.snapshot?.id ?? result.snapshotId ?? null;
  const metadata = normalizeMetadata(result.metadata);
  const now = new Date();

  const updateData: Record<string, unknown> = {
    updatedAt: now,
    completedAt: now,
  };

  if (resultStatus === 'completed') {
    updateData.status = 'completed';
    updateData.fileCount = result.filesBackedUp ?? null;
    updateData.totalSize = result.bytesBackedUp ?? null;
    updateData.backupType = result.backupType ?? null;
    if (result.warning) {
      updateData.errorLog = result.warning;
    }
  } else {
    updateData.status = 'failed';
    updateData.errorLog = result.error ?? result.warning ?? 'Unknown error';
    if (result.backupType) {
      updateData.backupType = result.backupType;
    }
  }

  if (providerSnapshotId) {
    updateData.snapshotId = providerSnapshotId;
  }

  const [updatedJob] = await db
    .update(backupJobs)
    .set(updateData)
    .where(
      and(
        eq(backupJobs.id, jobId),
        inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES)
      )
    )
    .returning({
      id: backupJobs.id,
      configId: backupJobs.configId,
      backupType: backupJobs.backupType,
    });

  if (!updatedJob) {
    return {
      applied: false,
      snapshotDbId: null,
      providerSnapshotId,
    };
  }

  if (resultStatus !== 'completed' || !providerSnapshotId) {
    return {
      applied: true,
      snapshotDbId: null,
      providerSnapshotId,
    };
  }

  const timestamp = result.snapshot?.timestamp
    ? new Date(result.snapshot.timestamp)
    : now;
  const snapshotBackupType =
    result.backupType ?? updatedJob.backupType ?? 'file';
  const snapshotMetadata: Record<string, unknown> = {
    ...metadata,
    hasIndexedFiles: Boolean(result.snapshot?.files?.length),
    fileIndexVersion: result.snapshot?.files?.length ? 1 : 0,
  };
  const snapshotLabel = buildSnapshotLabel(snapshotMetadata, timestamp);

  const snapshotValues = {
    orgId,
    jobId,
    deviceId,
    configId: updatedJob.configId ?? null,
    snapshotId: providerSnapshotId,
    label: snapshotLabel,
    location:
      typeof snapshotMetadata.storagePrefix === 'string'
        ? snapshotMetadata.storagePrefix
        : null,
    size: result.snapshot?.size ?? result.bytesBackedUp ?? null,
    fileCount: result.filesBackedUp ?? result.snapshot?.files?.length ?? null,
    timestamp,
    metadata: snapshotMetadata,
    backupType: snapshotBackupType,
  } as const;

  const [existingSnapshot] = await db
    .select({ id: backupSnapshots.id })
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.jobId, jobId),
        eq(backupSnapshots.snapshotId, providerSnapshotId)
      )
    )
    .limit(1);

  const [snapshot] = existingSnapshot
    ? await db
        .update(backupSnapshots)
        .set(snapshotValues)
        .where(eq(backupSnapshots.id, existingSnapshot.id))
        .returning()
    : await db.insert(backupSnapshots).values(snapshotValues).returning();

  if (snapshot && result.snapshot?.files) {
    await db
      .delete(backupSnapshotFiles)
      .where(eq(backupSnapshotFiles.snapshotDbId, snapshot.id));

    if (result.snapshot.files.length > 0) {
      const BATCH_SIZE = 1000;
      const fileRows = result.snapshot.files.map((file) => ({
        snapshotDbId: snapshot.id,
        sourcePath: file.sourcePath,
        backupPath: file.backupPath,
        size: file.size ?? null,
        modifiedAt: file.modTime ? new Date(file.modTime) : null,
      }));

      for (let i = 0; i < fileRows.length; i += BATCH_SIZE) {
        await db.insert(backupSnapshotFiles).values(fileRows.slice(i, i + BATCH_SIZE));
      }
    }
  }

  if (snapshot) {
    try {
      const protection = await resolveSnapshotProtectionSettingsForJob(jobId, timestamp);
      let protectionUpdate = {
        legalHold: protection.legalHold,
        legalHoldReason: protection.legalHoldReason,
        isImmutable: protection.isImmutable,
        immutableUntil: protection.immutableUntil,
        immutabilityEnforcement: protection.immutabilityEnforcement,
        requestedImmutabilityEnforcement: protection.requestedImmutabilityEnforcement,
        immutabilityFallbackReason: null as string | null,
        metadata: mergeSnapshotProtectionMetadata(snapshotMetadata, {
          legalHoldSource: protection.legalHoldSource,
        }),
      };

      if (
        protection.immutabilityEnforcement === 'provider' &&
        protection.isImmutable &&
        protection.immutableUntil
      ) {
        try {
          const storage = await resolveBackupConfigStorage(updatedJob.configId ?? null);
          if (!storage) {
            throw new Error('Backup config storage details unavailable');
          }

          const capability = await checkBackupProviderCapabilities({
            provider: storage.provider,
            providerConfig: storage.providerConfig,
          });
          if (!capability.objectLock.supported) {
            throw new Error(capability.objectLock.error ?? 'Bucket object lock is not enabled');
          }

          await applyBackupSnapshotImmutability({
            provider: storage.provider,
            providerConfig: storage.providerConfig,
            snapshotId: providerSnapshotId,
            metadata: snapshotMetadata,
            retainUntil: protection.immutableUntil,
          });
        } catch (err) {
          console.warn(
            `[BackupPersistence] Provider immutability unavailable for snapshot ${snapshot.id}; falling back to application enforcement:`,
            err instanceof Error ? err.message : err
          );
          protectionUpdate = {
            ...protectionUpdate,
            immutabilityEnforcement: 'application',
            immutabilityFallbackReason: err instanceof Error
              ? err.message
              : 'Provider-enforced immutability unavailable',
          };
        }
      }

      await db
        .update(backupSnapshots)
        .set(protectionUpdate)
        .where(eq(backupSnapshots.id, snapshot.id));
    } catch (err) {
      console.error(
        `[BackupPersistence] Failed to apply protection settings to snapshot ${snapshot.id}:`,
        err instanceof Error ? err.message : err
      );
    }

    try {
      await reconcileMssqlBackupChain({
        orgId,
        deviceId,
        configId: updatedJob.configId ?? null,
        snapshotDbId: snapshot.id,
        timestamp,
        metadata: snapshotMetadata,
      });
    } catch (err) {
      console.error(
        `[BackupPersistence] Failed to reconcile MSSQL chain for snapshot ${snapshot.id}:`,
        err instanceof Error ? err.message : err
      );
    }

    try {
      const tags = await applyGfsTagsToSnapshot(snapshot.id, timestamp, jobId);
      const gfsConfig = await resolveGfsConfigForJob(jobId);
      const expiresAt = computeExpiresAt(timestamp, tags, gfsConfig);
      if (expiresAt) {
        await db
          .update(backupSnapshots)
          .set({ expiresAt })
          .where(eq(backupSnapshots.id, snapshot.id));
      }
    } catch (err) {
      console.error(
        `[BackupPersistence] Failed to apply GFS tags to snapshot ${snapshot.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    applied: true,
    snapshotDbId: snapshot?.id ?? null,
    providerSnapshotId,
  };
}

export async function markBackupJobFailedIfInFlight(
  jobId: string,
  errorLog: string,
): Promise<boolean> {
  const rows = await db
    .update(backupJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      updatedAt: new Date(),
      errorLog,
    })
    .where(
      and(
        eq(backupJobs.id, jobId),
        inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES)
      )
    )
    .returning({ id: backupJobs.id });

  return rows.length > 0;
}
