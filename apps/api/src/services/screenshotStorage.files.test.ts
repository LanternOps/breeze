/**
 * Screenshot FILE lifecycle against a real temp directory (#8117).
 *
 * screenshotStorage.test.ts mocks `fs/promises`; this suite does not, so every
 * "the file is gone" / "the file is kept" assertion is checked on disk.
 *
 * Covers:
 * - the row's storage_key, not its current org_id, locates the file (org move)
 * - removeScreenshotFiles: removes, tolerates missing, logs and never throws
 * - sweepOrphanedScreenshotFiles: removes old files with no row, keeps
 *   referenced / fresh / foreign files, aborts on a DB failure
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { chmod, mkdir, writeFile, rm, utimes, access, readdir } from 'fs/promises';
import { join } from 'path';

const state = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/breeze-ss-files-${process.pid}-${Math.random().toString(36).slice(2)}`;
  process.env.SCREENSHOT_STORAGE_DIR = root;
  return {
    root,
    /** Rows the mocked db returns for every select. */
    selectRows: [] as unknown[],
    selectError: null as Error | null,
  };
});

vi.mock('../db', () => {
  const where = vi.fn(() => {
    if (state.selectError) return Promise.reject(state.selectError);
    const rows = state.selectRows;
    return Object.assign(Promise.resolve(rows), { limit: vi.fn(() => Promise.resolve(rows)) });
  });
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn(() => ({ where: deleteWhere }));
  return {
    db: { select, delete: del, insert: vi.fn() },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../db/schema/ai', () => ({
  aiScreenshots: {
    id: 'id',
    deviceId: 'device_id',
    orgId: 'org_id',
    sessionId: 'session_id',
    storageKey: 'storage_key',
    sizeBytes: 'size_bytes',
    expiresAt: 'expires_at',
  },
}));

vi.mock('./sentry', () => ({ captureMessage: vi.fn() }));

import {
  deleteExpiredScreenshots,
  getScreenshot,
  removeScreenshotFiles,
  removeUnreferencedScreenshotFiles,
  resolveScreenshotPath,
  sweepOrphanedScreenshotFiles,
} from './screenshotStorage';
import { db, withSystemDbAccessContext } from '../db';
import { captureMessage } from './sentry';

const OLD_ORG = '11111111-1111-4111-8111-111111111111';
const NEW_ORG = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const FILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FILE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FILE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const keyOf = (org: string, device: string, file: string) => `screenshots/${org}/${device}/${file}.jpg`;
const pathOf = (org: string, device: string, file: string) => join(state.root, org, device, `${file}.jpg`);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function put(path: string, ageMs = 0): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'jpeg-bytes');
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    await utimes(path, t, t);
  }
}

async function age(path: string, ageMs: number): Promise<void> {
  const t = new Date(Date.now() - ageMs);
  await utimes(path, t, t);
}

const TWO_HOURS = 2 * 60 * 60 * 1000;

beforeEach(async () => {
  vi.clearAllMocks();
  state.selectRows = [];
  state.selectError = null;
  await rm(state.root, { recursive: true, force: true });
  await mkdir(state.root, { recursive: true });
});

afterAll(async () => {
  await rm(state.root, { recursive: true, force: true });
});

describe('resolveScreenshotPath', () => {
  it('maps a storage key to a file under the storage root', () => {
    expect(resolveScreenshotPath(keyOf(OLD_ORG, DEVICE, FILE_A))).toBe(pathOf(OLD_ORG, DEVICE, FILE_A));
  });

  it.each([
    ['traversal segment', `screenshots/../${DEVICE}/${FILE_A}.jpg`],
    ['extra segments', `screenshots/${OLD_ORG}/../../${DEVICE}/${FILE_A}.jpg`],
    ['wrong prefix', `uploads/${OLD_ORG}/${DEVICE}/${FILE_A}.jpg`],
    ['absolute', `/screenshots/${OLD_ORG}/${DEVICE}/${FILE_A}.jpg`],
    ['wrong extension', `screenshots/${OLD_ORG}/${DEVICE}/${FILE_A}.png`],
    ['empty', ''],
  ])('rejects a malformed key (%s)', (_label, key) => {
    expect(resolveScreenshotPath(key)).toBeNull();
  });
});

describe('org move: the file is found through the row\'s storage_key', () => {
  it('getScreenshot reads a moved device\'s file from its original location', async () => {
    await put(pathOf(OLD_ORG, DEVICE, FILE_A));
    state.selectRows = [{
      id: 'row-1', orgId: NEW_ORG, deviceId: DEVICE, storageKey: keyOf(OLD_ORG, DEVICE, FILE_A),
    }];

    const result = await getScreenshot('row-1', NEW_ORG);

    expect(result?.data.toString()).toBe('jpeg-bytes');
  });

  it('the expiry sweep removes a moved device\'s file instead of orphaning it', async () => {
    const moved = pathOf(OLD_ORG, DEVICE, FILE_A);
    await put(moved);
    state.selectRows = [{
      id: 'row-1', orgId: NEW_ORG, deviceId: DEVICE, storageKey: keyOf(OLD_ORG, DEVICE, FILE_A),
      expiresAt: new Date(Date.now() - 1000),
    }];

    const deleted = await deleteExpiredScreenshots();

    expect(deleted).toBe(1);
    expect(await exists(moved)).toBe(false);
  });

  it('the expiry sweep reads and deletes rows in system scope (RLS would otherwise hide them)', async () => {
    state.selectRows = [];
    await deleteExpiredScreenshots();
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });
});

describe('removeScreenshotFiles', () => {
  it('removes every file and counts missing ones without failing', async () => {
    await put(pathOf(OLD_ORG, DEVICE, FILE_A));
    await put(pathOf(NEW_ORG, DEVICE, FILE_B));

    const result = await removeScreenshotFiles(
      [keyOf(OLD_ORG, DEVICE, FILE_A), keyOf(NEW_ORG, DEVICE, FILE_B), keyOf(OLD_ORG, DEVICE, FILE_C)],
      'test',
    );

    expect(result).toEqual({ removed: 2, missing: 1, failed: 0, unresolvable: 0 });
    expect(await exists(pathOf(OLD_ORG, DEVICE, FILE_A))).toBe(false);
    expect(await exists(pathOf(NEW_ORG, DEVICE, FILE_B))).toBe(false);
  });

  it('logs a failed unlink with a count, reports it to Sentry, keeps going, and does not throw', async () => {
    // A directory where the file should be: unlink fails with EISDIR/EPERM.
    await mkdir(pathOf(OLD_ORG, DEVICE, FILE_A), { recursive: true });
    await put(pathOf(OLD_ORG, DEVICE, FILE_B));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await removeScreenshotFiles(
        [keyOf(OLD_ORG, DEVICE, FILE_A), keyOf(OLD_ORG, DEVICE, FILE_B), 'screenshots/../../etc/passwd'],
        'org erasure',
      );

      expect(result).toEqual({ removed: 1, missing: 0, failed: 1, unresolvable: 1 });
      expect(await exists(pathOf(OLD_ORG, DEVICE, FILE_B))).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/org erasure.*1 of 3/), expect.anything());
      expect(captureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ eventCode: 'screenshot_file_removal_failed' }),
      );
      // The unresolvable key is a warning, not a "will retry" error.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/1 screenshot row\(s\) had an unrecognised storage key/), expect.anything());
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('does not alert for unresolvable keys alone', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await removeScreenshotFiles(['legacy/key.png'], 'test');
      expect(result).toEqual({ removed: 0, missing: 0, failed: 0, unresolvable: 1 });
      expect(captureMessage).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('is a no-op for an empty list', async () => {
    expect(await removeScreenshotFiles([], 'test')).toEqual({ removed: 0, missing: 0, failed: 0, unresolvable: 0 });
  });
});

describe('removeUnreferencedScreenshotFiles (request-path deletes, after the transaction settles)', () => {
  it('removes files whose rows are gone and keeps files a row still references (rolled-back delete)', async () => {
    await put(pathOf(OLD_ORG, DEVICE, FILE_A));
    await put(pathOf(OLD_ORG, DEVICE, FILE_B));
    // FILE_B's row is still there — e.g. the request transaction rolled back.
    state.selectRows = [{ storageKey: keyOf(OLD_ORG, DEVICE, FILE_B) }];

    const result = await removeUnreferencedScreenshotFiles(
      [keyOf(OLD_ORG, DEVICE, FILE_A), keyOf(OLD_ORG, DEVICE, FILE_B)],
      'site delete',
    );

    expect(await exists(pathOf(OLD_ORG, DEVICE, FILE_A))).toBe(false);
    expect(await exists(pathOf(OLD_ORG, DEVICE, FILE_B))).toBe(true);
    expect(result).toMatchObject({ removed: 1, stillReferenced: 1 });
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('removes nothing when the row re-check fails', async () => {
    await put(pathOf(OLD_ORG, DEVICE, FILE_A));
    state.selectError = new Error('connection terminated');

    await expect(removeUnreferencedScreenshotFiles([keyOf(OLD_ORG, DEVICE, FILE_A)], 'site delete'))
      .rejects.toThrow('connection terminated');
    expect(await exists(pathOf(OLD_ORG, DEVICE, FILE_A))).toBe(true);
  });
});

describe('deleteExpiredScreenshots edge cases', () => {
  it('deletes the row of an expired screenshot whose key is not one this service writes', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      state.selectRows = [{ id: 'row-bad', orgId: NEW_ORG, deviceId: DEVICE, storageKey: 'screenshots/../x.jpg' }];

      expect(await deleteExpiredScreenshots()).toBe(1);
      expect(db.delete).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('keeps the row and alerts when an expired file cannot be removed', async () => {
    // A directory where the file should be: unlink fails with EISDIR/EPERM.
    await mkdir(pathOf(OLD_ORG, DEVICE, FILE_A), { recursive: true });
    state.selectRows = [{ id: 'row-1', orgId: OLD_ORG, deviceId: DEVICE, storageKey: keyOf(OLD_ORG, DEVICE, FILE_A) }];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await deleteExpiredScreenshots()).toBe(0);
      expect(db.delete).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ eventCode: 'screenshot_file_removal_failed' }),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('sweepOrphanedScreenshotFiles', () => {
  it('removes old files with no row and keeps referenced, fresh and foreign files', async () => {
    const orphan = pathOf(OLD_ORG, DEVICE, FILE_A);
    const referenced = pathOf(OLD_ORG, DEVICE, FILE_B);
    const fresh = pathOf(NEW_ORG, DEVICE, FILE_C);
    const foreignInRoot = join(state.root, 'installer.zip');
    const foreignInDevice = join(state.root, OLD_ORG, DEVICE, 'notes.txt');
    await put(orphan, TWO_HOURS);
    await put(referenced, TWO_HOURS);
    await put(fresh);
    await put(foreignInRoot, TWO_HOURS);
    await put(foreignInDevice, TWO_HOURS);
    // Rows the DB still holds (a moved device's row keeps its original key).
    state.selectRows = [{ storageKey: keyOf(OLD_ORG, DEVICE, FILE_B) }];

    const result = await sweepOrphanedScreenshotFiles();

    expect(await exists(orphan)).toBe(false);
    expect(await exists(referenced)).toBe(true);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(foreignInRoot)).toBe(true);
    expect(await exists(foreignInDevice)).toBe(true);
    expect(result).toMatchObject({ scanned: 2, removed: 1, failed: 0 });
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('prunes an old empty device directory and its empty org directory', async () => {
    const deviceDir = join(state.root, OLD_ORG, DEVICE);
    await mkdir(deviceDir, { recursive: true });
    await age(deviceDir, TWO_HOURS);
    await age(join(state.root, OLD_ORG), TWO_HOURS);

    const result = await sweepOrphanedScreenshotFiles();

    expect(await exists(join(state.root, OLD_ORG))).toBe(false);
    expect(result.directoriesRemoved).toBe(2);
  });

  it('keeps a recently changed empty directory (a capture may be about to write into it)', async () => {
    await mkdir(join(state.root, OLD_ORG, DEVICE), { recursive: true });

    await sweepOrphanedScreenshotFiles();

    expect(await exists(join(state.root, OLD_ORG, DEVICE))).toBe(true);
  });

  it('removes nothing when the row lookup fails', async () => {
    const orphan = pathOf(OLD_ORG, DEVICE, FILE_A);
    await put(orphan, TWO_HOURS);
    state.selectError = new Error('connection terminated');

    await expect(sweepOrphanedScreenshotFiles()).rejects.toThrow('connection terminated');
    expect(await exists(orphan)).toBe(true);
  });

  it('returns zeros when the storage root does not exist yet', async () => {
    await rm(state.root, { recursive: true, force: true });
    expect(await sweepOrphanedScreenshotFiles()).toEqual({ scanned: 0, removed: 0, failed: 0, directoriesRemoved: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('leaves the storage root itself in place', async () => {
    await sweepOrphanedScreenshotFiles();
    expect(await readdir(state.root)).toEqual([]);
  });

  it('checks every candidate across several lookup batches', async () => {
    const files = Array.from({ length: 7 }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`);
    for (const f of files) await put(pathOf(OLD_ORG, DEVICE, f), TWO_HOURS);
    // Every other file is still referenced.
    const referenced = files.filter((_, i) => i % 2 === 0);
    state.selectRows = referenced.map((f) => ({ storageKey: keyOf(OLD_ORG, DEVICE, f) }));

    const result = await sweepOrphanedScreenshotFiles({ lookupBatchSize: 3 });

    expect(db.select).toHaveBeenCalledTimes(3); // 3 + 3 + 1
    for (const [i, f] of files.entries()) {
      expect(await exists(pathOf(OLD_ORG, DEVICE, f))).toBe(i % 2 === 0);
    }
    expect(result).toMatchObject({ scanned: 7, removed: 3, failed: 0 });
  });

  it('counts, logs and alerts an orphan it cannot remove, and still removes the rest', async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const lockedDir = join(state.root, OLD_ORG, DEVICE);
    const otherDevice = '44444444-4444-4444-8444-444444444444';
    await put(pathOf(OLD_ORG, DEVICE, FILE_A), TWO_HOURS);
    await put(pathOf(OLD_ORG, otherDevice, FILE_B), TWO_HOURS);
    await chmod(lockedDir, 0o555); // unlink inside it fails with EACCES
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await sweepOrphanedScreenshotFiles();

      expect(result).toMatchObject({ scanned: 2, removed: 1, failed: 1 });
      expect(await exists(pathOf(OLD_ORG, DEVICE, FILE_A))).toBe(true);
      expect(await exists(pathOf(OLD_ORG, otherDevice, FILE_B))).toBe(false);
      expect(captureMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ eventCode: 'screenshot_file_removal_failed' }),
      );
    } finally {
      await chmod(lockedDir, 0o755);
      errSpy.mockRestore();
    }
  });
});
