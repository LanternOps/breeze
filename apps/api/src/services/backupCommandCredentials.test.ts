import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  selectMock,
  hasDbAccessContextMock,
  withDbAccessContextMock,
  resolveReadMock,
  resolveWriteMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  hasDbAccessContextMock: vi.fn(() => false),
  withDbAccessContextMock: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  resolveReadMock: vi.fn(),
  resolveWriteMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...(a as [])) },
  hasDbAccessContext: () => hasDbAccessContextMock(),
  withDbAccessContext: (ctx: unknown, fn: () => Promise<unknown>) => withDbAccessContextMock(ctx, fn),
}));

vi.mock('./backupProviderConfig', () => ({
  resolveBackupProviderConfig: (...a: unknown[]) => resolveReadMock(...(a as [])),
  resolveBackupWriteCommandDestination: (...a: unknown[]) => resolveWriteMock(...(a as [])),
}));

import {
  BACKUP_READ_CREDENTIAL_COMMAND_TYPES,
  BACKUP_WRITE_CREDENTIAL_COMMAND_TYPES,
  PROVIDER_CONFIG_REF_FIELD,
  backupReadCredentialPayload,
  backupWriteCredentialPayload,
  materializeBackupStorageCredentials,
} from './backupCommandCredentials';
import { CommandDeliveryRefusedError } from './commandDeliveryRefusal';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const CONFIG = '44444444-4444-4444-8444-444444444444';
const COMMAND = '55555555-5555-4555-8555-555555555555';

const LOCAL_CONFIG = { path: '/srv/backups' };
const S3_CONFIG = {
  bucket: 'tenant-bucket',
  region: 'us-east-1',
  accessKey: 'AKIA-SYNTHETIC-ACCESS',
  secretKey: 'synthetic-secret-value',
};

function deviceRows(rows: unknown[]) {
  selectMock.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });
}

function ctx(type: string) {
  return { commandId: COMMAND, deviceId: DEVICE, type, claimedAt: new Date('2026-09-26T00:00:00Z') };
}

describe('backup command storage references', () => {
  it('builds a read reference that carries no credential material', () => {
    const payload = backupReadCredentialPayload(CONFIG, ORG, 's3');
    expect(payload).toEqual({ provider: 's3', [PROVIDER_CONFIG_REF_FIELD]: { configId: CONFIG, orgId: ORG } });
    expect(payload).not.toHaveProperty('providerConfig');
  });

  it('builds a write reference that keeps the non-secret encryption plan', () => {
    const payload = backupWriteCredentialPayload(CONFIG, ORG, {
      provider: 's3',
      storageEncryption: { required: true, mode: 's3-sse-s3', keyReference: null },
    });
    expect(payload).toEqual({
      provider: 's3',
      storageEncryption: { required: true, mode: 's3-sse-s3', keyReference: null },
      [PROVIDER_CONFIG_REF_FIELD]: { configId: CONFIG, orgId: ORG },
    });
    expect(payload).not.toHaveProperty('providerConfig');
  });

  it('covers every command type that reads or writes a storage destination from its payload', () => {
    expect([...BACKUP_READ_CREDENTIAL_COMMAND_TYPES].sort()).toEqual([
      'backup_restore',
      'backup_test_restore',
      'backup_verify',
      'hyperv_restore',
      'mssql_restore',
      'mssql_verify',
    ]);
    expect([...BACKUP_WRITE_CREDENTIAL_COMMAND_TYPES].sort()).toEqual(['hyperv_backup', 'mssql_backup']);
  });
});

describe('materializeBackupStorageCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasDbAccessContextMock.mockReturnValue(false);
    withDbAccessContextMock.mockImplementation(async (_ctx, fn) => fn());
    deviceRows([{ id: DEVICE }]);
    resolveReadMock.mockResolvedValue({ provider: 'local', providerConfig: LOCAL_CONFIG });
  });

  it('resolves a local read destination at delivery and returns the wire shape agents already read', async () => {
    const stored = {
      restoreJobId: 'restore-1',
      snapshotId: 'snap-1',
      ...backupReadCredentialPayload(CONFIG, ORG, 'local'),
    };

    const out = await materializeBackupStorageCredentials(stored, ctx('backup_restore'));

    expect(resolveReadMock).toHaveBeenCalledWith(CONFIG, ORG);
    expect(out).toEqual({
      restoreJobId: 'restore-1',
      snapshotId: 'snap-1',
      provider: 'local',
      providerConfig: LOCAL_CONFIG,
    });
    // The stored row is never mutated: the destination exists only in the
    // outgoing frame.
    expect(stored).not.toHaveProperty('providerConfig');
  });

  it.each(['backup_restore', 'backup_verify', 'backup_test_restore', 'mssql_restore', 'mssql_verify', 'hyperv_restore'])(
    'never resolves an S3 destination for the read %s: reads are served through storage sessions',
    async (type) => {
      resolveReadMock.mockResolvedValue({ provider: 's3', providerConfig: S3_CONFIG });
      await expect(
        materializeBackupStorageCredentials(backupReadCredentialPayload(CONFIG, ORG, 's3'), ctx(type)),
      ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    },
  );

  it('opens an organization-scoped context for the referenced org when none is held', async () => {
    await materializeBackupStorageCredentials(
      backupReadCredentialPayload(CONFIG, ORG, 'local'),
      ctx('backup_verify'),
    );
    expect(withDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(withDbAccessContextMock.mock.calls[0]![0]).toMatchObject({
      scope: 'organization',
      orgId: ORG,
      accessibleOrgIds: [ORG],
    });
  });

  it('joins the context the delivery path already holds instead of opening a second one', async () => {
    hasDbAccessContextMock.mockReturnValue(true);
    await materializeBackupStorageCredentials(
      backupReadCredentialPayload(CONFIG, ORG, 'local'),
      ctx('mssql_restore'),
    );
    expect(withDbAccessContextMock).not.toHaveBeenCalled();
    expect(resolveReadMock).toHaveBeenCalledWith(CONFIG, ORG);
  });

  it('refuses when the target device does not belong to the referenced organization', async () => {
    deviceRows([]);
    await expect(
      materializeBackupStorageCredentials(
        { ...backupReadCredentialPayload(CONFIG, OTHER_ORG, 's3') },
        ctx('backup_restore'),
      ),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    expect(resolveReadMock).not.toHaveBeenCalled();
  });

  it('refuses when the referenced configuration no longer resolves', async () => {
    resolveReadMock.mockResolvedValue(null);
    await expect(
      materializeBackupStorageCredentials(backupReadCredentialPayload(CONFIG, ORG, 's3'), ctx('hyperv_restore')),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
  });

  it('refuses when the destination provider changed after the command was queued', async () => {
    resolveReadMock.mockResolvedValue({ provider: 'local', providerConfig: LOCAL_CONFIG });
    await expect(
      materializeBackupStorageCredentials(backupReadCredentialPayload(CONFIG, ORG, 's3'), ctx('backup_restore')),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
  });

  it('refuses a malformed reference rather than guessing a destination', async () => {
    await expect(
      materializeBackupStorageCredentials(
        { provider: 's3', [PROVIDER_CONFIG_REF_FIELD]: { configId: 'not-a-uuid', orgId: ORG } },
        ctx('backup_restore'),
      ),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    await expect(
      materializeBackupStorageCredentials(
        { provider: 's3', [PROVIDER_CONFIG_REF_FIELD]: 'cfg' },
        ctx('backup_restore'),
      ),
    ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
  });

  it('passes a payload without a reference through untouched (rows queued before references existed)', async () => {
    const legacy = { snapshotId: 'snap-1', provider: 's3', providerConfig: S3_CONFIG };
    const out = await materializeBackupStorageCredentials(legacy, ctx('backup_restore'));
    expect(out).toBe(legacy);
    expect(selectMock).not.toHaveBeenCalled();
    expect(resolveReadMock).not.toHaveBeenCalled();
  });

  it('lets a transient lookup error propagate as an ordinary error so the row is retried', async () => {
    resolveReadMock.mockRejectedValue(new Error('connection reset'));
    const err = await materializeBackupStorageCredentials(
      backupReadCredentialPayload(CONFIG, ORG, 's3'),
      ctx('backup_restore'),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CommandDeliveryRefusedError);
  });

  describe('write commands', () => {
    const storageEncryption = { required: true, mode: 's3-sse-s3', keyReference: null } as const;

    beforeEach(() => {
      resolveWriteMock.mockResolvedValue({
        ok: true,
        destination: {
          provider: 's3',
          providerConfig: { ...S3_CONFIG, serverSideEncryption: 'AES256' },
          storageEncryption,
        },
      });
    });

    it('never resolves an S3 write destination into the frame: backups to S3 go through a write session', async () => {
      const err = await materializeBackupStorageCredentials(
        {
          jobId: 'job-1',
          configId: CONFIG,
          ...backupWriteCredentialPayload(CONFIG, ORG, { provider: 's3', storageEncryption }),
        },
        ctx('mssql_backup'),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandDeliveryRefusedError);
      expect((err as Error).message).toMatch(/secure storage session/);
    });

    it('never passes an inline S3 write destination through', async () => {
      await expect(
        materializeBackupStorageCredentials({ jobId: 'job-1', provider: 's3', providerConfig: S3_CONFIG }, ctx('hyperv_backup')),
      ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    });

    it('passes an inline local write destination through (a path, not a credential)', async () => {
      const inline = { jobId: 'job-1', provider: 'local', providerConfig: LOCAL_CONFIG };
      expect(await materializeBackupStorageCredentials(inline, ctx('mssql_backup'))).toBe(inline);
    });

    it('never passes an inline S3 destination through for a backup_run row', async () => {
      await expect(
        materializeBackupStorageCredentials({ jobId: 'job-1', provider: 's3', providerConfig: S3_CONFIG }, ctx('backup_run')),
      ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    });

    it('resolves a local write destination at delivery', async () => {
      resolveWriteMock.mockResolvedValue({
        ok: true,
        destination: { provider: 'local', providerConfig: LOCAL_CONFIG, storageEncryption: { required: false, mode: 'disabled' } },
      });
      const out = await materializeBackupStorageCredentials(
        { jobId: 'job-1', ...backupWriteCredentialPayload(CONFIG, ORG, { provider: 'local', storageEncryption: { required: false, mode: 'disabled' } }) },
        ctx('mssql_backup'),
      );
      expect(out).toEqual({
        jobId: 'job-1',
        provider: 'local',
        providerConfig: LOCAL_CONFIG,
        storageEncryption: { required: false, mode: 'disabled' },
      });
    });

    it('refuses when the encryption plan changed after the command was queued', async () => {
      await expect(
        materializeBackupStorageCredentials(
          backupWriteCredentialPayload(CONFIG, ORG, {
            provider: 's3',
            storageEncryption: { required: false, mode: 'disabled' },
          }),
          ctx('hyperv_backup'),
        ),
      ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    });

    it('refuses when the destination can no longer be built', async () => {
      resolveWriteMock.mockResolvedValue({ ok: false, reason: 'config_not_found', message: 'gone' });
      await expect(
        materializeBackupStorageCredentials(
          backupWriteCredentialPayload(CONFIG, ORG, { provider: 's3', storageEncryption }),
          ctx('mssql_backup'),
        ),
      ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    });

    describe('write dispatch telemetry', () => {
      const writeDispatch = vi.fn();
      beforeEach(async () => {
        writeDispatch.mockReset();
        const { setBackupMetricsRecorder } = await import('./backupMetrics');
        setBackupMetricsRecorder({ onWriteDispatch: writeDispatch });
      });
      afterEach(async () => {
        const { setBackupMetricsRecorder } = await import('./backupMetrics');
        setBackupMetricsRecorder(null);
      });

      it('never counts a write as delivered with its storage credential', async () => {
        await expect(materializeBackupStorageCredentials(
          backupWriteCredentialPayload(CONFIG, ORG, { provider: 's3', storageEncryption }),
          ctx('mssql_backup'),
        )).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
        expect(writeDispatch.mock.calls).toEqual([['mssql_backup', 'refused', 'provider_not_local', 1]]);
      });

      it('counts a write to a local destination as a local write', async () => {
        resolveWriteMock.mockResolvedValue({
          ok: true,
          destination: { provider: 'local', providerConfig: LOCAL_CONFIG, storageEncryption: { required: false, mode: 'disabled' } },
        });
        await materializeBackupStorageCredentials(
          backupWriteCredentialPayload(CONFIG, ORG, { provider: 'local', storageEncryption: { required: false, mode: 'disabled' } }),
          ctx('hyperv_backup'),
        );
        expect(writeDispatch.mock.calls).toEqual([['hyperv_backup', 'local', 'no_credential', 1]]);
      });

      it('does not count a write refused for its configuration, or a read', async () => {
        resolveWriteMock.mockResolvedValue({ ok: false, reason: 'config_not_found', message: 'gone' });
        await expect(
          materializeBackupStorageCredentials(
            backupWriteCredentialPayload(CONFIG, ORG, { provider: 's3', storageEncryption }),
            ctx('mssql_backup'),
          ),
        ).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
        resolveReadMock.mockResolvedValue({ provider: 'local', providerConfig: LOCAL_CONFIG });
        await materializeBackupStorageCredentials(backupReadCredentialPayload(CONFIG, ORG, 'local'), ctx('backup_restore'));
        expect(writeDispatch).not.toHaveBeenCalled();
      });
    });
  });
});
