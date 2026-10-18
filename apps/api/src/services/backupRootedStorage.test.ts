import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listing = { key: string; lastModified: Date | null };
const iterateMock = vi.fn();
const fetchTextMock = vi.fn();
const deleteKeysMock = vi.fn();
vi.mock('./backupSnapshotStorage', () => ({
  iterateBackupObjectsUnderPrefix: iterateMock,
  fetchBackupObjectText: fetchTextMock,
  deleteBackupObjectKeys: deleteKeysMock,
}));

const {
  BackupKeyRootInvariantError,
  deleteRootedObjectKeys,
  fetchRootedObjectText,
  iterateRootedObjects,
} = await import('./backupRootedStorage');
const { LEGACY_FLAT_ROOT } = await import('./backupKeyLayout');

const P = { layout: 'prefixed_flat', prefix: 'orgB' } as const;
const s3 = { provider: 's3', providerConfig: { bucket: 'shared', region: 'us-east-1' } };
const at = new Date('2026-01-01T00:00:00Z');

function pagesOf(...pages: Listing[][]) {
  return (async function* () {
    for (const page of pages) yield page;
  })();
}

async function collect(it: AsyncIterable<Listing[]>): Promise<Listing[][]> {
  const out: Listing[][] = [];
  for await (const page of it) out.push(page);
  return out;
}

describe('rooted backup storage', () => {
  beforeEach(() => {
    iterateMock.mockReset();
    fetchTextMock.mockReset();
    deleteKeysMock.mockReset();
  });

  it('the legacy root passes every call through unchanged', async () => {
    iterateMock.mockReturnValue(pagesOf([{ key: 'snapshots/a1/manifest.json', lastModified: at }]));
    fetchTextMock.mockResolvedValue('{}');
    deleteKeysMock.mockResolvedValue({ deletedKeys: ['snapshots/a1/x'], failedKeys: [] });
    const storage = { ...s3, root: LEGACY_FLAT_ROOT };

    expect(await collect(iterateRootedObjects(storage, 'snapshots'))).toEqual([[{ key: 'snapshots/a1/manifest.json', lastModified: at }]]);
    expect(iterateMock).toHaveBeenCalledWith({ provider: 's3', providerConfig: s3.providerConfig, prefix: 'snapshots' });

    await fetchRootedObjectText(storage, 'snapshots/a1/manifest.json', 10);
    expect(fetchTextMock).toHaveBeenCalledWith({ provider: 's3', providerConfig: s3.providerConfig, key: 'snapshots/a1/manifest.json', maxBytes: 10 });

    expect(await deleteRootedObjectKeys(storage, ['snapshots/a1/x'])).toEqual({ deletedKeys: ['snapshots/a1/x'], failedKeys: [] });
    expect(deleteKeysMock).toHaveBeenCalledWith({ provider: 's3', providerConfig: s3.providerConfig, keys: ['snapshots/a1/x'] });
  });

  it('a prefixed root lists, fetches and deletes physical keys and hands back logical ones', async () => {
    iterateMock.mockReturnValue(pagesOf(
      [{ key: 'orgB/snapshots/b1/manifest.json', lastModified: at }],
      [{ key: 'orgB/snapshots/b1/files/f', lastModified: null }],
    ));
    fetchTextMock.mockResolvedValue('{"files":[]}');
    deleteKeysMock.mockResolvedValue({
      deletedKeys: ['orgB/snapshots/b1/files/f'],
      failedKeys: [{ key: 'orgB/snapshots/b1/files/g', error: 'AccessDenied' }],
    });
    const storage = { ...s3, root: P };

    expect(await collect(iterateRootedObjects(storage, 'snapshots/b1'))).toEqual([
      [{ key: 'snapshots/b1/manifest.json', lastModified: at }],
      [{ key: 'snapshots/b1/files/f', lastModified: null }],
    ]);
    expect(iterateMock).toHaveBeenCalledWith({ provider: 's3', providerConfig: s3.providerConfig, prefix: 'orgB/snapshots/b1' });

    expect(await fetchRootedObjectText(storage, 'snapshots/b1/manifest.json')).toBe('{"files":[]}');
    expect(fetchTextMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'orgB/snapshots/b1/manifest.json' }));

    expect(await deleteRootedObjectKeys(storage, ['snapshots/b1/files/f', 'snapshots/b1/files/g'])).toEqual({
      deletedKeys: ['snapshots/b1/files/f'],
      failedKeys: [{ key: 'snapshots/b1/files/g', error: 'AccessDenied' }],
    });
    expect(deleteKeysMock).toHaveBeenCalledWith({
      provider: 's3', providerConfig: s3.providerConfig, keys: ['orgB/snapshots/b1/files/f', 'orgB/snapshots/b1/files/g'],
    });
  });

  it('aborts a listing that returns a key outside the root', async () => {
    iterateMock.mockReturnValue(pagesOf([{ key: 'snapshots/a1/manifest.json', lastModified: at }]));
    await expect(collect(iterateRootedObjects({ ...s3, root: P }, 'snapshots'))).rejects.toBeInstanceOf(BackupKeyRootInvariantError);
  });

  it('never reports a key it was not asked to delete', async () => {
    deleteKeysMock.mockResolvedValue({
      deletedKeys: ['orgB/snapshots/b1/a', 'snapshots/b1/a'],
      failedKeys: [{ key: 'elsewhere/x', error: 'boom' }],
    });
    const result = await deleteRootedObjectKeys({ ...s3, root: P }, ['snapshots/b1/a']);
    expect(result).toEqual({ deletedKeys: ['snapshots/b1/a'], failedKeys: [] });
  });

  it('refuses a prefixed root on a provider other than S3 before any storage call', async () => {
    const local = { provider: 'local', providerConfig: { path: '/tmp/x' }, root: P };
    await expect(collect(iterateRootedObjects(local, 'snapshots'))).rejects.toBeInstanceOf(BackupKeyRootInvariantError);
    await expect(fetchRootedObjectText(local, 'snapshots/b1/manifest.json')).rejects.toBeInstanceOf(BackupKeyRootInvariantError);
    await expect(deleteRootedObjectKeys(local, ['snapshots/b1/a'])).rejects.toBeInstanceOf(BackupKeyRootInvariantError);
    expect(iterateMock).not.toHaveBeenCalled();
    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(deleteKeysMock).not.toHaveBeenCalled();
  });

  it('an empty delete makes no storage call', async () => {
    expect(await deleteRootedObjectKeys({ ...s3, root: P }, [])).toEqual({ deletedKeys: [], failedKeys: [] });
    expect(deleteKeysMock).not.toHaveBeenCalled();
  });
});
