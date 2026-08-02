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
  sanitizeVssMetadata,
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

  // #3006: a reconcile-sourced completion is evidence read straight out of the
  // destination bucket (`snapshots/<id>/manifest.json` exists), so it may adopt
  // ANY failed job — not just one the stale reaper marked. Asserted on the
  // guard expression itself because the chainable mock ignores the WHERE.
  it('drops the reaper-marker requirement for a reconcile-sourced completion', async () => {
    const guardFor = async (source: 'agent' | 'reconcile') => {
      vi.mocked(db.update).mockReturnValue(chainMock([]) as any);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await applyBackupCommandResultToJob({
        jobId: 'job-1',
        orgId: 'org-1',
        deviceId: 'device-1',
        resultStatus: 'completed',
        result: { snapshotId: 'provider-snap-1', filesBackedUp: 1 },
        source,
      });
      const where = vi.mocked(db.update).mock.results[0]!.value.where.mock.calls[0][0];
      return JSON.stringify(where);
    };

    const agentGuard = await guardFor('agent');
    expect(agentGuard).toContain('[stale-backup-reaper]');
    expect(agentGuard).toContain('failed');
    expect(agentGuard).not.toContain('cancelled');
    expect(agentGuard).not.toContain('partial');

    vi.mocked(db.update).mockReset();
    const reconcileGuard = await guardFor('reconcile');
    expect(reconcileGuard).not.toContain('[stale-backup-reaper]');
    expect(reconcileGuard).toContain('failed');
    // `completed` is allowed ONLY so a half-written adoption (job flipped, but
    // the backup_snapshots insert never landed) stays recoverable; reconcile
    // only ever passes such a job after confirming no restore point exists.
    expect(reconcileGuard).toContain('completed');
    // A user cancel is a deliberate decision, and a `partial` job already
    // recorded its own outcome — neither may ever be resurrected.
    expect(reconcileGuard).not.toContain('cancelled');
    expect(reconcileGuard).not.toContain('partial');
  });

  // #3006: a reconcile adoption can flip a job the AGENT genuinely failed (no
  // reaper marker). Nulling error_log there would destroy the only record of
  // why the run reported failure — the forensic trail behind a snapshot that
  // may have been attributed by write time alone.
  it('preserves a genuine agent failure message when reconcile adopts the job', async () => {
    vi.mocked(db.update).mockReturnValue(chainMock([]) as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 1 },
      source: 'reconcile',
    });

    const setArg = vi.mocked(db.update).mock.results[0]!.value.set.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(setArg.errorLog).not.toBeNull();
    const errorLogSql = JSON.stringify(setArg.errorLog);
    expect(errorLogSql).toContain('[reconciled-from-storage] prior failure: ');
    // The stale-reaper note is noise, not evidence — that one still clears.
    expect(errorLogSql).toContain('[stale-backup-reaper]');
    // Re-adoption is an EXPECTED path (that is why `completed` is adoptable),
    // so the prefix must be self-matching or it compounds on every retry:
    // "[reconciled-from-storage] prior failure: [reconciled-from-storage] …".
    expect(errorLogSql).toContain('[reconciled-from-storage] prior failure: %');
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


// #3000: a run that produced a real snapshot but lost a disproportionate share
// of its work is reported by the agent as `partial`. It must be persisted as a
// distinct terminal status WITHOUT losing any of the success-path persistence —
// the snapshot is real and restorable, so dropping its backup_snapshots row
// would strand it in the bucket.
describe('partial backup terminal status (#3000)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveBackupProtectionForDeviceMock.mockReset();
  });

  function mockSuccessPath() {
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file', backupMode: 'file' }]) as any)
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
  }

  function setArgs() {
    return vi.mocked(db.update).mock.results[0]?.value?.set;
  }

  it('writes status "partial" when the agent reports a partial run', async () => {
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      agentStatus: 'partial',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 1,
        bytesBackedUp: 85,
        errorCount: 21,
        warning: '21 of 22 files failed to upload',
      } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(expect.objectContaining({
      status: 'partial',
      // The counters and the failure summary must still be recorded — the
      // partial status ADDS a signal, it does not replace the existing ones.
      fileCount: 1,
      totalSize: 85,
      errorCount: 21,
      errorLog: '21 of 22 files failed to upload',
    }));
  });

  it('still creates the backup_snapshots row for a partial run', async () => {
    mockSuccessPath();

    const outcome = await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      agentStatus: 'partial',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 1, errorCount: 21 } as any,
    });

    // The whole point of `partial` rather than `failed`: a real, restorable
    // snapshot exists and must be recorded.
    expect(db.insert).toHaveBeenCalled();
    expect(outcome.applied).toBe(true);
    expect(outcome.snapshotDbId).toBe('snapshot-db-1');
    expect(outcome.providerSnapshotId).toBe('provider-snap-1');
  });

  it('writes status "completed" when the agent reports no partial status', async () => {
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 4 } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('collapses an agent status that is not a backup_status enum value to completed', async () => {
    // The agent's vocabulary is wider than the DB enum — it also emits
    // `skipped` and `stopped`. Writing one of those straight through would
    // blow up the UPDATE with an invalid enum value.
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      agentStatus: 'skipped',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 0 } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('collapses an unrecognized agent status LOUDLY, not silently', async () => {
    // Silently greening a status we do not model is the #3000 bug class itself.
    // We still record `completed` (a non-enum value would fail the UPDATE and
    // lose the whole result) but it must be findable afterwards.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      agentStatus: 'some-future-status',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 1 } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('some-future-status'));
    expect(captureExceptionMock).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn for an ordinary completed run', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      agentStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 1 } as any,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('keeps a failed result failed even if an agent status rides along', async () => {
    vi.mocked(db.update).mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1' }]) as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'failed',
      agentStatus: 'partial',
      result: { error: 'provider unreachable' } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('VSS metadata persistence (#3027)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveBackupProtectionForDeviceMock.mockReset();
  });

  function mockSuccessPath() {
    vi.mocked(db.update)
      .mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1', backupType: 'file', backupMode: 'file' }]) as any)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([]) as any);
    vi.mocked(db.select)
      .mockReturnValueOnce(chainMock([]) as any)
      .mockReturnValueOnce(chainMock([{ featureLinkId: null, policyId: null, deviceId: 'device-1' }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(chainMock([{
      id: 'snapshot-db-1',
      jobId: 'job-1',
      snapshotId: 'provider-snap-1',
    }]) as any);
    vi.mocked(applyGfsTagsToSnapshot).mockResolvedValue({ daily: true });
    vi.mocked(resolveGfsConfigForJob).mockResolvedValue(null);
    vi.mocked(computeExpiresAt).mockReturnValue(null);
  }

  function setArgs() {
    return vi.mocked(db.update).mock.results[0]?.value?.set;
  }

  it('writes vss_metadata on a SUCCESSFUL run — a green job whose volumes were read live is the whole point', async () => {
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: {
        snapshotId: 'provider-snap-1',
        filesBackedUp: 4,
        vssMetadata: {
          shadowCopyId: 'set-1',
          writers: [{ name: 'NTDS', id: 'w-1', state: 'failed', lastError: 'timed out' }],
          unprotectedVolumes: ['D:\\'],
          durationMs: 900,
        },
      } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(expect.objectContaining({
      vssMetadata: expect.objectContaining({
        shadowCopyId: 'set-1',
        unprotectedVolumes: ['D:\\'],
        writers: [{ name: 'NTDS', id: 'w-1', state: 'failed', lastError: 'timed out' }],
      }),
    }));
  });

  it('writes vss_metadata on a FAILED run too — writer state is what explains the failure', async () => {
    vi.mocked(db.update).mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1' }]) as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'failed',
      result: {
        error: 'snapshot creation failed',
        vssMetadata: { shadowCopyId: 'set-2', writers: [{ name: 'SqlServerWriter', state: 'failed' }] },
      } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      vssMetadata: expect.objectContaining({ shadowCopyId: 'set-2' }),
    }));
  });

  it('leaves the column untouched for a legacy agent that reports no vssMetadata', async () => {
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', filesBackedUp: 4 } as any,
    });

    // NOT `vssMetadata: null` — overwriting a previously-recorded blob with NULL
    // on a retry would destroy the diagnostics we are here to keep.
    expect(setArgs()).toHaveBeenCalledWith(
      expect.not.objectContaining({ vssMetadata: expect.anything() }),
    );
  });

  it('escalates when an agent sends an UNUSABLE vssMetadata instead of dropping it silently', async () => {
    // `z.unknown()` at both boundaries means nothing upstream rejects garbage —
    // correct, but absent and present-but-broken must not look identical, or a
    // fleet-wide agent regression that malformed this field is invisible forever.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSuccessPath();

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'completed',
      result: { snapshotId: 'provider-snap-1', vssMetadata: 'not-an-object' } as any,
    });

    expect(setArgs()).toHaveBeenCalledWith(
      expect.not.objectContaining({ vssMetadata: expect.anything() }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unusable vssMetadata'));
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('unusable vssMetadata') }),
    );
    warnSpy.mockRestore();
  });

  it('keeps the degradation warning alongside the failure reason in errorLog', async () => {
    // A total VSS failure produces NO vssMetadata, so job.Warning is its only
    // channel. The old `error ?? warning` chain always picked `error` (which is
    // set on every failure path), so the note explaining WHY the run was
    // degraded never reached the UI.
    vi.mocked(db.update).mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1' }]) as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'failed',
      result: {
        error: 'upload destination unreachable',
        warning: 'VSS shadow copy could not be created, so every path was read from the live volume',
      } as any,
    });

    const errorLog = vi.mocked(db.update).mock.results[0]?.value?.set.mock.calls[0][0].errorLog as string;
    expect(errorLog).toContain('upload destination unreachable');
    expect(errorLog).toContain('read from the live volume');
  });

  it('does not duplicate the text when error and warning are identical', async () => {
    vi.mocked(db.update).mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1' }]) as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'failed',
      result: { error: 'disk full', warning: 'disk full' } as any,
    });

    const errorLog = vi.mocked(db.update).mock.results[0]?.value?.set.mock.calls[0][0].errorLog as string;
    expect(errorLog).toBe('disk full');
  });

  it('still falls back to the warning alone when there is no error text', async () => {
    vi.mocked(db.update).mockReturnValueOnce(chainMock([{ id: 'job-1', configId: 'config-1' }]) as any);

    await applyBackupCommandResultToJob({
      jobId: 'job-1',
      orgId: 'org-1',
      deviceId: 'device-1',
      resultStatus: 'failed',
      result: { warning: 'VSS shadow copy could not be created' } as any,
    });

    const errorLog = vi.mocked(db.update).mock.results[0]?.value?.set.mock.calls[0][0].errorLog as string;
    expect(errorLog).toBe('VSS shadow copy could not be created');
  });
});

describe('sanitizeVssMetadata (#3027)', () => {
  it('returns undefined for absent / non-object input so the column is not written', () => {
    expect(sanitizeVssMetadata(undefined)).toBeUndefined();
    expect(sanitizeVssMetadata(null)).toBeUndefined();
    expect(sanitizeVssMetadata([] as any)).toBeUndefined();
  });

  it('keeps the modeled fields verbatim when the payload is ordinary', () => {
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      creationTime: '2026-08-02T00:00:00Z',
      writers: [{ name: 'NTDS', id: 'w-1', state: 'stable' }],
      exposedPaths: { 'C:\\': '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1' },
      unprotectedVolumes: ['D:\\'],
      warnings: ['volume D:\\ has no shadow copy'],
      durationMs: 4200,
    } as any);

    expect(sanitized).toEqual({
      shadowCopyId: 'set-1',
      creationTime: '2026-08-02T00:00:00Z',
      writers: [{ name: 'NTDS', id: 'w-1', state: 'stable' }],
      exposedPaths: { 'C:\\': '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1' },
      unprotectedVolumes: ['D:\\'],
      warnings: ['volume D:\\ has no shadow copy'],
      durationMs: 4200,
    });
  });

  it('keeps an unmodeled SCALAR, drops an unmodeled CONTAINER, and NAMES the drop', () => {
    // Same rule the agent's own IPC bounding uses (reduceToScalars): a future
    // agent field stays forward-compatible without reopening the unbounded hole.
    // Naming it matters — otherwise a new agent field appears to work in dev
    // (where you read the agent log) and silently does nothing in production.
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      providerVersion: '10.0.0',
      snapshotAttempts: 3,
      hugeFutureBlob: Array.from({ length: 10 }, (_, i) => `entry-${i}`),
      futureObject: { a: 1 },
    } as any) as Record<string, unknown>;

    expect(sanitized.providerVersion).toBe('10.0.0');
    expect(sanitized.snapshotAttempts).toBe(3);
    expect(sanitized.hugeFutureBlob).toBeUndefined();
    expect(sanitized.futureObject).toBeUndefined();
    expect(sanitized.warnings).toEqual([
      'unmodeled VSS field(s) dropped: futureObject, hugeFutureBlob',
    ]);
  });

  it('caps oversized arrays and NAMES what it dropped in warnings', () => {
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      writers: Array.from({ length: 500 }, (_, i) => ({ name: `w-${i}`, state: 'stable' })),
      unprotectedVolumes: Array.from({ length: 500 }, (_, i) => `V${i}:\\`),
    } as any) as Record<string, unknown>;

    expect((sanitized.writers as unknown[]).length).toBe(24);
    expect((sanitized.unprotectedVolumes as unknown[]).length).toBe(24);
    // Truncation is never silent.
    expect(sanitized.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('476 additional VSS writer entries were dropped'),
      expect.stringContaining('476 additional unprotected-volume entries were dropped'),
    ]));
  });

  it('NAMES ill-typed unprotectedVolumes rather than silently reporting a clean snapshot', () => {
    // The nastiest regression this function can cause: a future agent sends
    // [{volume:'D:\\'}], the filter reduces it to [], the UI's length check
    // reads "no unprotected volumes", and a degraded snapshot presents as
    // clean — #3027's exact failure mode one layer up.
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      unprotectedVolumes: [{ volume: 'D:\\' }, { volume: 'E:\\' }],
    } as any) as Record<string, unknown>;

    expect(sanitized.unprotectedVolumes).toEqual([]);
    expect(sanitized.warnings).toEqual([
      expect.stringContaining('2 unprotected-volume entries were dropped: not strings'),
    ]);
    expect(String((sanitized.warnings as string[])[0])).toContain('may have read volumes live');
  });

  it('NAMES a non-list unprotectedVolumes / writers instead of dropping them quietly', () => {
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      unprotectedVolumes: 'D:\\',
      writers: 'SqlServerWriter',
    } as any) as Record<string, unknown>;

    expect(sanitized.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('unprotected-volume detail was dropped'),
      expect.stringContaining('VSS writer detail was dropped'),
    ]));
  });

  it('NAMES ill-typed writer and shadow-path entries', () => {
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      writers: ['SqlServerWriter', 'NTDS', { name: 'Registry', state: 'stable' }],
      exposedPaths: { 'C:\\': '\\\\?\\GLOBALROOT\\x', 'D:\\': 42 },
    } as any) as Record<string, unknown>;

    expect((sanitized.writers as unknown[]).length).toBe(1);
    expect(sanitized.exposedPaths).toEqual({ 'C:\\': '\\\\?\\GLOBALROOT\\x' });
    expect(sanitized.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('2 VSS writer entries were dropped: not objects'),
      expect.stringContaining('1 shadow-path entries were dropped: not strings'),
    ]));
  });

  it('keeps a scalar `warnings` string instead of erasing it', () => {
    // It used to be copied by the unmodeled-scalar pass and then deleted by the
    // warnings merge — the text was not ignored, it was destroyed.
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      warnings: 'volume D:\\ has no shadow copy',
    } as any) as Record<string, unknown>;

    expect(sanitized.warnings).toEqual(['volume D:\\ has no shadow copy']);
  });

  it('drops the bulk containers but KEEPS unprotectedVolumes when the blob is still oversize', async () => {
    // Writers each carrying a max-length lastError blows the byte budget.
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      writers: Array.from({ length: 24 }, (_, i) => ({
        name: `w-${i}`,
        state: 'failed',
        lastError: 'x'.repeat(1024),
      })),
      exposedPaths: Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => [`V${i}:\\`, 'y'.repeat(1024)]),
      ),
      unprotectedVolumes: ['D:\\'],
      warnings: Array.from({ length: 24 }, () => 'z'.repeat(1024)),
    } as any) as Record<string, unknown>;

    expect(sanitized.writers).toBeUndefined();
    expect(sanitized.exposedPaths).toBeUndefined();
    // The field that actually says "this snapshot is incomplete" survives.
    expect(sanitized.unprotectedVolumes).toEqual(['D:\\']);
    expect(sanitized.shadowCopyId).toBe('set-1');
    expect(sanitized.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('exceeded the size limit'),
    ]));
  });

  it('measures the size cap in BYTES, not UTF-16 code units', () => {
    // A multi-byte payload that is comfortably under the cap by `String.length`
    // but over it in actual jsonb bytes must still be bounded. Each emoji is
    // 4 UTF-8 bytes but 2 UTF-16 units.
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      writers: Array.from({ length: 24 }, (_, i) => ({
        name: `w-${i}`,
        lastError: '🔥'.repeat(512),
      })),
      exposedPaths: Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => [`V${i}:\\`, '🔥'.repeat(512)]),
      ),
      unprotectedVolumes: Array.from({ length: 24 }, () => '🔥'.repeat(512)),
      warnings: Array.from({ length: 24 }, () => '🔥'.repeat(512)),
    } as any);

    expect(Buffer.byteLength(JSON.stringify(sanitized), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps a bounded unprotectedVolumes even in the pathological last-resort tier', () => {
    // Discarding it is the one loss that turns a degraded snapshot back into a
    // clean-looking one, so even the last resort must not.
    const sanitized = sanitizeVssMetadata({
      unprotectedVolumes: Array.from({ length: 24 }, () => '🔥'.repeat(512)),
      warnings: Array.from({ length: 24 }, () => '🔥'.repeat(512)),
    } as any) as Record<string, unknown>;

    expect(Array.isArray(sanitized.unprotectedVolumes)).toBe(true);
    expect((sanitized.unprotectedVolumes as unknown[]).length).toBeGreaterThan(0);
  });

  it('truncates a pathologically long string rather than storing it', () => {
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'z'.repeat(50_000),
    } as any) as Record<string, unknown>;

    expect((sanitized.shadowCopyId as string).length).toBeLessThan(1_200);
    expect(sanitized.shadowCopyId).toContain('[truncated]');
  });

  it('redacts a secret an agent leaked into a VSS warning', () => {
    const sanitized = sanitizeVssMetadata({
      shadowCopyId: 'set-1',
      warnings: ['writer failed: -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'],
    } as any) as Record<string, unknown>;

    expect(JSON.stringify(sanitized)).not.toContain('MIIabc');
  });
});
