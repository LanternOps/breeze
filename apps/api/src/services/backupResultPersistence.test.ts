import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  backupJobs: {
    id: 'backupJobs.id',
    status: 'backupJobs.status',
    configId: 'backupJobs.configId',
    backupType: 'backupJobs.backupType',
    backupMode: 'backupJobs.backupMode',
    featureLinkId: 'backupJobs.featureLinkId',
    policyId: 'backupJobs.policyId',
    deviceId: 'backupJobs.deviceId',
    errorLog: 'backupJobs.errorLog',
  },
  backupSnapshots: {
    id: 'backupSnapshots.id',
    jobId: 'backupSnapshots.jobId',
    snapshotId: 'backupSnapshots.snapshotId',
    legalHold: 'backupSnapshots.legalHold',
    legalHoldReason: 'backupSnapshots.legalHoldReason',
    isImmutable: 'backupSnapshots.isImmutable',
    immutableUntil: 'backupSnapshots.immutableUntil',
    immutabilityEnforcement: 'backupSnapshots.immutabilityEnforcement',
    requestedImmutabilityEnforcement: 'backupSnapshots.requestedImmutabilityEnforcement',
    immutabilityFallbackReason: 'backupSnapshots.immutabilityFallbackReason',
    encryptionKeyId: 'backupSnapshots.encryptionKeyId',
  },
  backupSnapshotFiles: {
    snapshotDbId: 'backupSnapshotFiles.snapshotDbId',
  },
  backupPolicies: {
    id: 'backupPolicies.id',
    legalHold: 'backupPolicies.legalHold',
    legalHoldReason: 'backupPolicies.legalHoldReason',
  },
  backupConfigs: {
    id: 'backupConfigs.id',
    provider: 'backupConfigs.provider',
    providerConfig: 'backupConfigs.providerConfig',
  },
  configPolicyBackupSettings: {
    featureLinkId: 'configPolicyBackupSettings.featureLinkId',
    retention: 'configPolicyBackupSettings.retention',
  },
  IN_FLIGHT_BACKUP_JOB_STATUSES: ['pending', 'running'] as const,
  STALE_BACKUP_REAP_MARKER: '[stale-backup-reaper]',
}));

const captureExceptionMock = vi.fn();
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

vi.mock('../db/schema/applicationBackup', () => ({
  backupChains: {
    id: 'backupChains.id',
    orgId: 'backupChains.orgId',
    deviceId: 'backupChains.deviceId',
    configId: 'backupChains.configId',
    chainType: 'backupChains.chainType',
    targetName: 'backupChains.targetName',
    targetId: 'backupChains.targetId',
    fullSnapshotId: 'backupChains.fullSnapshotId',
    chainMetadata: 'backupChains.chainMetadata',
  },
}));

vi.mock('../jobs/backupRetention', () => ({
  applyGfsTagsToSnapshot: vi.fn(),
  computeExpiresAt: vi.fn(),
  resolveGfsConfigForJob: vi.fn(),
}));

vi.mock('./backupSnapshotStorage', () => ({
  applyBackupSnapshotImmutability: vi.fn(),
  checkBackupProviderCapabilities: vi.fn(),
}));

const resolveBackupProtectionForDeviceMock = vi.fn();
vi.mock('./featureConfigResolver', () => ({
  resolveBackupProtectionForDevice: (...args: unknown[]) =>
    resolveBackupProtectionForDeviceMock(...(args as [])),
}));

import { db } from '../db';
import {
  applyBackupCommandResultToJob,
  markBackupJobFailedIfInFlight,
} from './backupResultPersistence';
import {
  applyGfsTagsToSnapshot,
  computeExpiresAt,
  resolveGfsConfigForJob,
} from '../jobs/backupRetention';
import { applyBackupSnapshotImmutability } from './backupSnapshotStorage';
import { checkBackupProviderCapabilities } from './backupSnapshotStorage';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

describe('backup result persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveBackupProtectionForDeviceMock.mockReset();
  });

  it('ignores stale backup job results when the job is no longer in flight', async () => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const result = await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    expect(result).toEqual({
      applied: false,
      snapshotDbId: null,
      providerSnapshotId: 'provider-snap-1',
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('marks a backup job failed only while it is still pending or running', async () => {
    const returning = vi.fn().mockResolvedValueOnce([{ id: 'job-1' }]).mockResolvedValueOnce([]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning,
        }),
      }),
    } as any);

    await expect(markBackupJobFailedIfInFlight('job-1', 'boom')).resolves.toBe(true);
    await expect(markBackupJobFailedIfInFlight('job-1', 'boom')).resolves.toBe(false);
  });

  it('stamps snapshot protection settings from the winning backup feature link', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: true,
      legalHoldReason: 'Regulatory hold',
      immutabilityMode: 'application',
      immutableDays: 45,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: true,
        error: null,
      },
    });

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
        metadata: {
          encryptionKeyId: '11111111-1111-4111-8111-111111111111',
        },
      },
    });

    const insertValues = vi.mocked(db.insert).mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      encryptionKeyId: '11111111-1111-4111-8111-111111111111',
    }));

    expect(db.update).toHaveBeenNthCalledWith(2, expect.anything());
    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      legalHold: true,
      legalHoldReason: 'Regulatory hold',
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: 'application',
      immutabilityFallbackReason: null,
      immutableUntil: expect.any(Date),
      metadata: expect.objectContaining({
        snapshotProtection: expect.objectContaining({
          legalHoldSource: 'policy',
        }),
      }),
    }));
  });

  it('labels a system_image snapshot and persists its system-state manifest + hardware profile', async () => {
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: null, backupMode: 'system_image' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);

    const manifest = {
      platform: 'windows',
      osVersion: 'Microsoft Windows [Version 10.0.20348.169]',
      hostname: 'WIN-TEST',
      artifacts: [{ name: 'registry_SYSTEM', category: 'registry', path: 'registry/SYSTEM', sizeBytes: 100 }],
      hardwareProfile: { cpuModel: 'Xeon', cpuCores: 4, totalMemoryMB: 8192 },
    };

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 13,
        // backup_run for system_image carries no backupType — it must be
        // derived from the job's backup_mode, not defaulted to 'file'.
        systemStateManifest: manifest,
      } as any,
    });

    const insertValues = vi.mocked(db.insert).mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      backupType: 'system_image',
      systemStateManifest: manifest,
      hardwareProfile: manifest.hardwareProfile,
    }));
  });

  it('does not mislabel a file backup: no backupType, non-system_image mode → file', async () => {
    // Regression guard: the system_image derivation must not leak onto file
    // jobs. A file backup_run sends no backupType and backupMode='file', so the
    // snapshot must fall through to 'file' (and carry no manifest).
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: null, backupMode: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: 'snapshot-db-1', jobId: 'job-1', snapshotId: 'provider-snap-1' }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 5 } as any,
    });

    const insertValues = vi.mocked(db.insert).mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      backupType: 'file',
      systemStateManifest: null,
      hardwareProfile: null,
    }));
  });

  it('honors an explicit result.backupType over the mode-derived value', async () => {
    // mssql/hyperv send an explicit backupType; it must win over derivation.
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: null, backupMode: 'mssql' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: 'snapshot-db-1', jobId: 'job-1', snapshotId: 'provider-snap-1' }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 1, backupType: 'database' } as any,
    });

    const insertValues = vi.mocked(db.insert).mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ backupType: 'database' }));
  });

  it('applies provider immutability when the winning feature link requests it', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: false,
      legalHoldReason: null,
      immutabilityMode: 'provider',
      immutableDays: 14,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any)
      .mockReturnValueOnce(chainMock([{
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
      }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: true,
        error: null,
      },
    });
    vi.mocked(applyBackupSnapshotImmutability).mockResolvedValue({
      enforcement: 'provider',
      objectCount: 3,
    });

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    expect(applyBackupSnapshotImmutability).toHaveBeenCalledWith(expect.objectContaining({
      provider: 's3',
      snapshotId: 'provider-snap-1',
      retainUntil: expect.any(Date),
    }));
    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      isImmutable: true,
      immutabilityEnforcement: 'provider',
      requestedImmutabilityEnforcement: 'provider',
      immutabilityFallbackReason: null,
      immutableUntil: expect.any(Date),
    }));
  });

  it('falls back to application immutability when provider locking fails', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: false,
      legalHoldReason: null,
      immutabilityMode: 'provider',
      immutableDays: 30,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any)
      .mockReturnValueOnce(chainMock([{
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
      }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: true,
        error: null,
      },
    });
    vi.mocked(applyBackupSnapshotImmutability).mockRejectedValue(new Error('Object lock unavailable'));

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: 'provider',
      immutabilityFallbackReason: 'Object lock unavailable',
      immutableUntil: expect.any(Date),
    }));
  });

  it('falls back immediately when the runtime capability re-check fails', async () => {
    resolveBackupProtectionForDeviceMock.mockResolvedValueOnce({
      legalHold: false,
      legalHoldReason: null,
      immutabilityMode: 'provider',
      immutableDays: 30,
      sourceFeatureLinkIds: ['feature-1'],
    });
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: 'feature-1', policyId: null, deviceId: 'device-1' }]) as any)
      .mockReturnValueOnce(chainMock([{
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
      }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
    vi.mocked(checkBackupProviderCapabilities).mockResolvedValue({
      objectLock: {
        supported: false,
        error: 'Bucket object lock no longer enabled',
      },
    });

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
      },
    });

    expect(applyBackupSnapshotImmutability).not.toHaveBeenCalled();
    const protectionSet = vi.mocked(db.update).mock.results[1]?.value?.set;
    expect(protectionSet).toHaveBeenCalledWith(expect.objectContaining({
      isImmutable: true,
      immutabilityEnforcement: 'application',
      requestedImmutabilityEnforcement: 'provider',
      immutabilityFallbackReason: 'Bucket object lock no longer enabled',
      immutableUntil: expect.any(Date),
    }));
  });

  it('redacts secrets from the agent-supplied error before persisting errorLog (#2434)', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';
    const updateChain = chainMock([{ id: 'job-1', configId: null, backupType: 'file' }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'failed',
      result: {
        error: `backup failed, key follows:\n${pem}`,
      },
    });

    const setArg = updateChain.set.mock.calls[0][0] as { errorLog: string };
    expect(setArg.errorLog).toContain('[PRIVATE_KEY_REDACTED]');
    expect(setArg.errorLog).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('redacts secrets from the agent-supplied warning persisted to errorLog on success (#2434)', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';
    const updateChain = chainMock([{ id: 'job-1', configId: null, backupType: 'file' }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        filesBackedUp: 4,
        warning: `partial backup, key follows:\n${pem}`,
      },
    });

    const setArg = updateChain.set.mock.calls[0][0] as { errorLog: string };
    expect(setArg.errorLog).toContain('[PRIVATE_KEY_REDACTED]');
    expect(setArg.errorLog).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('persists warning + errorCount for a partially-successful completed run', async () => {
    const updateChain = chainMock([{ id: 'job-1', configId: null, backupType: 'file' }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    const outcome = await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        filesBackedUp: 8,
        warning: '2 of 10 files failed to upload: upload stalled; disk read error',
        errorCount: 2,
      },
    });

    expect(outcome.applied).toBe(true);
    const setArg = updateChain.set.mock.calls[0][0] as {
      status: string;
      errorLog: string;
      errorCount: number;
    };
    expect(setArg.status).toBe('completed');
    expect(setArg.errorCount).toBe(2);
    expect(setArg.errorLog).toContain('2 of 10 files failed to upload');
  });

  it('does not write errorCount when the agent result carries none', async () => {
    const updateChain = chainMock([{ id: 'job-1', configId: null, backupType: 'file' }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { filesBackedUp: 4 },
    });

    const setArg = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('errorCount');
  });

  it('persists referencedSize + referencedFiles for an incremental run that deduped files', async () => {
    const updateChain = chainMock([{ id: 'job-1', configId: null, backupType: 'file' }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    const outcome = await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        filesBackedUp: 3,
        bytesBackedUp: 1_000,
        referencedBytes: 50_000,
        referencedFiles: 17,
      },
    });

    expect(outcome.applied).toBe(true);
    const setArg = updateChain.set.mock.calls[0][0] as {
      referencedSize: number;
      referencedFiles: number;
    };
    expect(setArg.referencedSize).toBe(50_000);
    expect(setArg.referencedFiles).toBe(17);
  });

  it('does not write referencedSize/referencedFiles when the agent result carries neither (old agent)', async () => {
    const updateChain = chainMock([{ id: 'job-1', configId: null, backupType: 'file' }]);
    vi.mocked(db.update).mockReturnValue(updateChain as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { filesBackedUp: 4 },
    });

    const setArg = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('referencedSize');
    expect(setArg).not.toHaveProperty('referencedFiles');
  });

  it('FIX 7: records a late success on a reaper-failed job (flips failed→completed, clears the reaper errorLog, creates the snapshot)', async () => {
    // The guarded UPDATE now also matches a `failed` row whose error_log carries
    // the reaper marker. The chainable mock ignores the WHERE, so we assert the
    // observable effects of the flip: status→completed, error_log cleared, and a
    // backup_snapshots row created for the (previously stranded) snapshot.
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file', backupMode: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any) // existing snapshot: none → insert
      .mockReturnValueOnce(chainMock([{ featureLinkId: null, policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);

    const outcome = await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 4, bytesBackedUp: 2048 },
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.snapshotDbId).toBe('snapshot-db-1');
    const setArg = vi.mocked(db.update).mock.results[0]!.value.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.status).toBe('completed');
    expect(setArg.errorLog).toBeNull();
    expect(db.insert).toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('FIX 7 fallback: logs + captureException when a late success cannot be recorded (user-cancelled / already-terminal job) so the snapshot is not silently orphaned', async () => {
    // The guarded UPDATE matches nothing (job is `cancelled` or a non-reaper
    // `failed`), so the snapshot in storage has no backup_snapshots row.
    vi.mocked(db.update).mockReturnValue(chainMock([]) as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await applyBackupCommandResultToJob({
      jobId: 'job-cancelled',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-9', filesBackedUp: 4 },
    });

    expect(outcome.applied).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const capturedErr = captureExceptionMock.mock.calls[0]![0] as Error;
    expect(capturedErr.message).toContain('provider-snap-9');
    expect(capturedErr.message).toContain('job-cancelled');
    errorSpy.mockRestore();
  });
});

