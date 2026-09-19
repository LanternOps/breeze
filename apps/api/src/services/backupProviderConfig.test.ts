import { beforeEach, describe, expect, it, vi } from 'vitest';

// D20b item A: on-demand mssql/hyperv backup routes need the SAME
// provider/providerConfig/storageEncryption shape backupWorker.ts's
// prepareBackupDispatchTargets already attaches to a profile-scheduled
// mssql_backup/hyperv_backup command. buildBackupWriteCommandDestination is
// the extracted, pure version of that logic; resolveBackupWriteCommandDestination
// is the DB-querying wrapper the routes call with only a configId in hand.

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
}));

vi.mock('../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
    encryption: 'backup_configs.encryption',
  },
}));

import {
  buildBackupWriteCommandDestination,
  resolveBackupWriteCommandDestination,
  BACKUP_DESTINATION_CONFIG_NOT_FOUND_MESSAGE,
} from './backupProviderConfig';

describe('buildBackupWriteCommandDestination', () => {
  it('carries provider + providerConfig through with storageEncryption disabled when encryption is off', () => {
    const result = buildBackupWriteCommandDestination({
      provider: 's3',
      providerConfig: { bucket: 'backups', region: 'us-east-1' },
      encryption: false,
    });

    expect(result).toEqual({
      ok: true,
      destination: {
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
        storageEncryption: { required: false, mode: 'disabled' },
      },
    });
  });

  it('patches providerConfig and reports storageEncryption when S3 SSE-S3 is enforced', () => {
    const result = buildBackupWriteCommandDestination({
      provider: 's3',
      providerConfig: { bucket: 'backups', region: 'us-east-1', encryption: { mode: 'sse-s3' } },
      encryption: true,
    });

    expect(result).toEqual({
      ok: true,
      destination: {
        provider: 's3',
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          encryption: { mode: 'sse-s3' },
          serverSideEncryption: 'AES256',
        },
        storageEncryption: { required: true, mode: 's3-sse-s3', keyReference: null },
      },
    });
  });

  it('fails closed (ok:false) instead of silently downgrading when encryption is required but unsupported', () => {
    const result = buildBackupWriteCommandDestination({
      provider: 'local',
      providerConfig: { path: '/backups' },
      encryption: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('encryption_unsupported');
      expect(result.message).toMatch(/enforceable only for S3 storage/);
    }
  });

  it('defaults a null providerConfig to an empty object rather than throwing', () => {
    const result = buildBackupWriteCommandDestination({
      provider: 'local',
      providerConfig: null,
      encryption: false,
    });

    expect(result).toEqual({
      ok: true,
      destination: {
        provider: 'local',
        providerConfig: {},
        storageEncryption: { required: false, mode: 'disabled' },
      },
    });
  });
});

describe('resolveBackupWriteCommandDestination', () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it('resolves the destination for a real configId+orgId pair', async () => {
    selectMock.mockReturnValueOnce(chainMock([
      { provider: 'local', providerConfig: { path: '/backups' }, encryption: false },
    ]));

    const result = await resolveBackupWriteCommandDestination('config-1', 'org-1');

    expect(result).toEqual({
      ok: true,
      destination: {
        provider: 'local',
        providerConfig: { path: '/backups' },
        storageEncryption: { required: false, mode: 'disabled' },
      },
    });
  });

  it('returns config_not_found (not a throw) when no row matches configId+orgId', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const result = await resolveBackupWriteCommandDestination('missing-config', 'org-1');

    expect(result).toEqual({
      ok: false,
      reason: 'config_not_found',
      message: BACKUP_DESTINATION_CONFIG_NOT_FOUND_MESSAGE,
    });
  });
});
