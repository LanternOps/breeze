import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  deleteBackupObjectKeys,
  fetchBackupObjectText,
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

  // A bare "snapshots" Prefix string-matches ANY key starting with those
  // characters ("snapshots-old/…", "snapshotsummary.txt", …), not just the
  // "snapshots/" namespace. GC's listing must scope with a trailing slash, and
  // must not trust a misbehaving/mocked provider that ignores the Prefix it
  // was given.
  describe('listBackupObjectsUnderPrefix — S3 namespace scoping', () => {
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

  // S3 delete-response classification: a per-key error in response.Errors
  // (e.g. object-lock rejection) must be counted as FAILED, never silently
  // treated as deleted; deletes batch by 1000 keys per DeleteObjectsCommand.
  describe('deleteBackupObjectKeys — S3 delete classification', () => {
    it('classifies a per-key error as failed rather than deleted', async () => {
      sendMock.mockImplementationOnce(async (command) => {
        expect(command).toBeInstanceOf(DeleteObjectsCommand);
        return {
          // k1 succeeded (absent from Errors); k2 rejected by object lock.
          Errors: [{ Key: 'snapshots/s/k2.dat', Message: 'AccessDenied', Code: 'AccessDenied' }],
        };
      });

      const result = await deleteBackupObjectKeys({
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
        keys: ['snapshots/s/k1.dat', 'snapshots/s/k2.dat'],
      });

      expect(result.deletedKeys).toEqual(['snapshots/s/k1.dat']);
      expect(result.failedKeys).toEqual([
        { key: 'snapshots/s/k2.dat', error: 'AccessDenied' },
      ]);
    });

    it('batches deletes by 1000 keys per request', async () => {
      sendMock.mockResolvedValue({ Errors: [] });
      const keys = Array.from({ length: 1500 }, (_, i) => `snapshots/s/obj-${i}.dat`);

      const result = await deleteBackupObjectKeys({
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
        keys,
      });

      // 1500 keys → two batches (1000 + 500).
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(result.deletedKeys).toHaveLength(1500);
      expect(result.failedKeys).toHaveLength(0);
    });

    it('classifies an entire batch as failed when the DeleteObjects call throws', async () => {
      sendMock.mockRejectedValueOnce(new Error('network down'));

      const result = await deleteBackupObjectKeys({
        provider: 's3',
        providerConfig: { bucket: 'backups', region: 'us-east-1' },
        keys: ['snapshots/s/a.dat', 'snapshots/s/b.dat'],
      });

      expect(result.deletedKeys).toEqual([]);
      expect(result.failedKeys.map((f) => f.key)).toEqual(['snapshots/s/a.dat', 'snapshots/s/b.dat']);
      expect(result.failedKeys.every((f) => f.error === 'network down')).toBe(true);
    });
  });
});

// Local-provider GC I/O exercised against a REAL tempdir (no mocks): the
// directory walk, mtime/age reporting, the path-containment guard, and
// key-scoped deletion.
describe('local-provider GC I/O (real filesystem)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'breeze-gc-local-'));
    await mkdir(join(root, 'snapshots', 'snapA', 'files'), { recursive: true });
    await writeFile(join(root, 'snapshots', 'snapA', 'manifest.json'), '{"files":[]}');
    await writeFile(join(root, 'snapshots', 'snapA', 'files', 'a.dat'), 'aaa');
    await writeFile(join(root, 'snapshots', 'snapA', 'files', 'b.dat'), 'bbb');
    // An out-of-namespace sibling that a "snapshots" prefix walk must NOT reach.
    await mkdir(join(root, 'other'), { recursive: true });
    await writeFile(join(root, 'other', 'unrelated.dat'), 'zzz');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('walks the snapshot root and reports every file key with a real mtime', async () => {
    const listing = await listBackupObjectsUnderPrefix({
      provider: 'local',
      providerConfig: { path: root },
      prefix: 'snapshots',
    });

    const keys = listing.map((l) => l.key).sort();
    expect(keys).toEqual([
      'snapshots/snapA/files/a.dat',
      'snapshots/snapA/files/b.dat',
      'snapshots/snapA/manifest.json',
    ]);
    // Never escapes the prefix into the sibling directory.
    expect(keys).not.toContain('other/unrelated.dat');
    // Every entry carries a usable last-modified Date for the age gate.
    for (const item of listing) {
      expect(item.lastModified).toBeInstanceOf(Date);
      expect(Number.isNaN(item.lastModified!.getTime())).toBe(false);
    }
  });

  it('fetches a local object as text', async () => {
    const text = await fetchBackupObjectText({
      provider: 'local',
      providerConfig: { path: root },
      key: 'snapshots/snapA/manifest.json',
    });
    expect(text).toBe('{"files":[]}');
  });

  it('deletes only the intended keys, leaving siblings intact', async () => {
    const result = await deleteBackupObjectKeys({
      provider: 'local',
      providerConfig: { path: root },
      keys: ['snapshots/snapA/files/a.dat'],
    });

    expect(result.deletedKeys).toEqual(['snapshots/snapA/files/a.dat']);
    expect(result.failedKeys).toEqual([]);

    const remaining = await readdir(join(root, 'snapshots', 'snapA', 'files'));
    expect(remaining).toEqual(['b.dat']); // a.dat gone, b.dat untouched
  });

  it('enforces the containment guard against path-traversal keys (fetch)', async () => {
    await expect(
      fetchBackupObjectText({
        provider: 'local',
        providerConfig: { path: root },
        key: '../../etc/passwd',
      }),
    ).rejects.toThrow('path traversal detected');
  });

  it('enforces the containment guard against path-traversal keys (delete)', async () => {
    const result = await deleteBackupObjectKeys({
      provider: 'local',
      providerConfig: { path: root },
      keys: ['../../../etc/passwd'],
    });
    // Never throws — the traversal attempt is classified as a failed key.
    expect(result.deletedKeys).toEqual([]);
    expect(result.failedKeys).toHaveLength(1);
    expect(result.failedKeys[0]!.error).toContain('path traversal detected');
  });
});
