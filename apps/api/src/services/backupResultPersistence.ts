import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  backupJobs,
  backupSnapshotFiles,
  backupSnapshots,
} from '../db/schema';
import { backupChains } from '../db/schema/applicationBackup';
import {
  applyGfsTagsToSnapshot,
  computeExpiresAt,
  resolveGfsConfigForJob,
} from '../jobs/backupRetention';
import type { ParsedBackupCommandResult } from '../routes/backup/resultSchemas';

export const IN_FLIGHT_BACKUP_JOB_STATUSES = ['pending', 'running'] as const;

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
