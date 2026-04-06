import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  PutObjectRetentionCommand,
} from '@aws-sdk/client-s3';

const sendMock = vi.fn();

vi.mock('./recoveryMediaService', () => ({
  buildS3Client: vi.fn(() => ({
    send: sendMock,
  })),
}));

import {
  applyBackupSnapshotImmutability,
  checkBackupProviderCapabilities,
} from './backupSnapshotStorage';

describe('backup snapshot storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports object lock support for S3 buckets with object lock enabled', async () => {
    sendMock.mockImplementationOnce(async (command) => {
      expect(command).toBeInstanceOf(GetObjectLockConfigurationCommand);
      return {
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
        },
      };
    });

    const result = await checkBackupProviderCapabilities({
      provider: 's3',
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
      },
    });

    expect(result).toEqual({
      objectLock: {
        supported: true,
        error: null,
      },
    });
  });

  it('returns an explicit unsupported capability result for non-S3 providers', async () => {
    const result = await checkBackupProviderCapabilities({
      provider: 'local',
      providerConfig: { path: '/backups' },
    });

    expect(result).toEqual({
      objectLock: {
        supported: false,
        error: 'Object lock is only supported for S3 providers',
      },
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('normalizes access denied errors from object lock checks', async () => {
    sendMock.mockRejectedValueOnce(new Error('AccessDenied: denied'));

    const result = await checkBackupProviderCapabilities({
      provider: 's3',
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
      },
    });

    expect(result).toEqual({
      objectLock: {
        supported: false,
        error: 'Access denied checking object lock configuration',
      },
    });
  });

  it('normalizes timeout errors from object lock checks', async () => {
    sendMock.mockRejectedValueOnce(new Error('Request timeout'));

    const result = await checkBackupProviderCapabilities({
      provider: 's3',
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
      },
    });

    expect(result).toEqual({
      objectLock: {
        supported: false,
        error: 'Timed out checking object lock configuration',
      },
    });
  });

  it('applies GOVERNANCE retention to each object in the snapshot prefix', async () => {
    sendMock
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        return {
          Contents: [
            { Key: 'snapshots/provider-snap-1/a' },
            { Key: 'snapshots/provider-snap-1/b' },
          ],
          IsTruncated: false,
        };
      })
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(PutObjectRetentionCommand);
        expect(command.input.Retention?.Mode).toBe('GOVERNANCE');
        return {};
      })
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(PutObjectRetentionCommand);
        expect(command.input.Retention?.Mode).toBe('GOVERNANCE');
        return {};
      });

    const result = await applyBackupSnapshotImmutability({
      provider: 's3',
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
      },
      snapshotId: 'provider-snap-1',
      metadata: {},
      retainUntil: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result).toEqual({
      enforcement: 'provider',
      objectCount: 2,
    });
  });

  it('fails when no objects are found for provider immutability', async () => {
    sendMock.mockImplementationOnce(async () => ({
      Contents: [],
      IsTruncated: false,
    }));

    await expect(applyBackupSnapshotImmutability({
      provider: 's3',
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
      },
      snapshotId: 'provider-snap-1',
      metadata: {},
      retainUntil: new Date('2026-04-30T00:00:00.000Z'),
    })).rejects.toThrow('No snapshot objects found for provider-enforced immutability');
  });
});
