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
  listBackupObjectsUnderPrefix,
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

  // GC review 2026-07-17, CRITICAL 2: a bare "snapshots" Prefix string-matches
  // ANY key starting with those characters ("snapshots-old/…",
  // "snapshotsummary.txt", …), not just the "snapshots/" namespace. GC's
  // listing must scope with a trailing slash, and must not trust a
  // misbehaving/mocked provider that ignores the Prefix it was given.
  describe('listBackupObjectsUnderPrefix — S3 namespace scoping (CRITICAL 2)', () => {
    it('lists with a trailing-slash-scoped prefix, not a bare namespace string', async () => {
      sendMock.mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        expect(command.input.Prefix).toBe('snapshots/');
        return {
          Contents: [{ Key: 'snapshots/abc/manifest.json', LastModified: new Date('2026-01-01') }],
          IsTruncated: false,
        };
      });

      const result = await listBackupObjectsUnderPrefix({
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
        prefix: 'snapshots',
      });

      expect(result).toEqual([
        { key: 'snapshots/abc/manifest.json', lastModified: new Date('2026-01-01') },
      ]);
    });

    it('filters out an out-of-namespace lookalike key even if a misbehaving provider returns one', async () => {
      sendMock.mockImplementationOnce(async () => ({
        Contents: [
          { Key: 'snapshots/abc/manifest.json', LastModified: new Date('2026-01-01') },
          // Lookalikes a bare "snapshots" prefix match would have let through —
          // must never become GC delete candidates.
          { Key: 'snapshots-old/db.dump', LastModified: new Date('2020-01-01') },
          { Key: 'snapshotsummary.txt', LastModified: new Date('2020-01-01') },
        ],
        IsTruncated: false,
      }));

      const result = await listBackupObjectsUnderPrefix({
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
        prefix: 'snapshots',
      });

      expect(result).toEqual([
        { key: 'snapshots/abc/manifest.json', lastModified: new Date('2026-01-01') },
      ]);
      expect(result.map((r) => r.key)).not.toContain('snapshots-old/db.dump');
      expect(result.map((r) => r.key)).not.toContain('snapshotsummary.txt');
    });
  });
});
