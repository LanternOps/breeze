import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteObjectsCommand,
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
  deleteBackupSnapshotArtifacts,
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

  it('does not apply retention to adjacent S3 snapshot prefixes', async () => {
    const retainedKeys: string[] = [];
    sendMock
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        expect(command.input.Prefix).toBe('snapshots/provider-snap-1');
        return {
          Contents: [
            { Key: 'snapshots/provider-snap-1/manifest.json' },
            { Key: 'snapshots/provider-snap-10/manifest.json' },
            { Key: 'snapshots/provider-snap-1-extra/manifest.json' },
          ],
          IsTruncated: false,
        };
      })
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(PutObjectRetentionCommand);
        retainedKeys.push(command.input.Key);
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

    expect(result.objectCount).toBe(1);
    expect(retainedKeys).toEqual(['snapshots/provider-snap-1/manifest.json']);
  });

  it('does not delete adjacent S3 snapshot prefixes', async () => {
    const deletedKeys: string[] = [];
    sendMock
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        return {
          Contents: [
            { Key: 'snapshots/provider-snap-1/manifest.json' },
            { Key: 'snapshots/provider-snap-10/manifest.json' },
            { Key: 'snapshots/provider-snap-1-extra/manifest.json' },
          ],
          IsTruncated: false,
        };
      })
      .mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(DeleteObjectsCommand);
        deletedKeys.push(
          ...(command.input.Delete?.Objects ?? []).map((object: { Key?: string }) => object.Key ?? '')
        );
        return {};
      });

    await deleteBackupSnapshotArtifacts({
      provider: 's3',
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
      },
      snapshotId: 'provider-snap-1',
      metadata: {},
    });

    expect(deletedKeys).toEqual(['snapshots/provider-snap-1/manifest.json']);
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
