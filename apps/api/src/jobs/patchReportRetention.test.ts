/**
 * Patch compliance report retention against a real temp directory: every
 * "the file is gone" / "the file is kept" assertion is checked on disk. The
 * database is mocked; the real-Postgres path is covered by the patch report
 * integration suite.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, rm, symlink, utimes, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const state = vi.hoisted(() => {
  const base = `${process.env.TMPDIR ?? '/tmp'}/breeze-patch-retention-${process.pid}-${Math.random().toString(36).slice(2)}`;
  process.env.PATCH_REPORT_STORAGE_PATH = `${base}/patch-reports`;
  delete process.env.PATCH_REPORT_RETENTION_DAYS;
  delete process.env.PATCH_REPORT_ORPHAN_MIN_AGE_MS;
  return {
    base,
    root: `${base}/patch-reports`,
    /** Successive pages the expiry scan returns. */
    expiryPages: [] as Array<Array<{ id: string; outputPath: string | null }>>,
    /** Rows the orphan lookup returns (ids that still own their file). */
    referencedRows: [] as Array<{ id: string }>,
    lookupError: null as Error | null,
    updates: [] as Array<{ set: Record<string, unknown>; ids: unknown }>,
    /** Every inArray() right-hand side, in call order. */
    inArrayCalls: [] as unknown[],
    contexts: [] as Array<string | undefined>,
  };
});

vi.mock('bullmq', () => ({ Job: class {}, Queue: vi.fn(), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureMessage: vi.fn() }));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    inArray: ((left: unknown, right: unknown) => {
      state.inArrayCalls.push(right);
      return (actual.inArray as (l: unknown, r: unknown) => unknown)(left, right);
    }) as typeof actual.inArray,
  };
});

vi.mock('../db/schema', () => ({
  patchComplianceReports: {
    id: 'reports.id',
    status: 'reports.status',
    outputPath: 'reports.outputPath',
    completedAt: 'reports.completedAt',
    createdAt: 'reports.createdAt',
    updatedAt: 'reports.updatedAt',
  },
}));

vi.mock('../db', () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        // The orphan lookup awaits `where` directly; the expiry scan pages
        // through `orderBy().limit()`.
        const lookup = state.lookupError
          ? Promise.reject(state.lookupError)
          : Promise.resolve(state.referencedRows);
        lookup.catch(() => {});
        return Object.assign(lookup, {
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => state.expiryPages.shift() ?? []),
          })),
        });
      }),
    })),
  }));
  // The expiry UPDATE matches every id it is given (the last inArray call).
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => {
        const ids = state.inArrayCalls.at(-1) as string[];
        state.updates.push({ set: values, ids });
        return { returning: vi.fn(async () => ids.map((id) => ({ id }))) };
      }),
    })),
  }));
  return {
    db: { select, update },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>, label?: string) => {
      state.contexts.push(label);
      return fn();
    }),
  };
});

import {
  expirePatchReportFiles,
  runPatchReportRetentionOnce,
  sweepOrphanedPatchReportFiles,
} from './patchReportRetention';
import { withSystemDbAccessContext } from '../db';
import { captureMessage } from '../services/sentry';

const REPORT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPORT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REPORT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date();

const fileOf = (id: string) => join(state.root, `${id}.csv`);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeReport(path: string, ageDays: number): Promise<void> {
  await writeFileAged(path, ageDays * DAY_MS);
}

async function writeFileAged(path: string, ageMs: number): Promise<void> {
  await writeFile(path, 'metric,value\n', 'utf8');
  const when = new Date(NOW.getTime() - ageMs);
  await utimes(path, when, when);
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.PATCH_REPORT_RETENTION_DAYS;
  delete process.env.PATCH_REPORT_ORPHAN_MIN_AGE_MS;
  process.env.PATCH_REPORT_STORAGE_PATH = state.root;
  await rm(state.base, { recursive: true, force: true });
  await mkdir(state.root, { recursive: true });
  state.expiryPages = [];
  state.referencedRows = [];
  state.lookupError = null;
  state.updates = [];
  state.inArrayCalls = [];
  state.contexts = [];
});

afterAll(async () => {
  await rm(state.base, { recursive: true, force: true });
});

describe('expirePatchReportFiles', () => {
  it('removes an expired report file and marks its row expired with no output path', async () => {
    await writeReport(fileOf(REPORT_A), 40);
    state.expiryPages = [[{ id: REPORT_A, outputPath: fileOf(REPORT_A) }]];

    const result = await expirePatchReportFiles({ now: NOW });

    expect(result).toEqual({ expired: 1, keptForRetry: 0 });
    expect(await exists(fileOf(REPORT_A))).toBe(false);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toEqual(expect.objectContaining({ status: 'expired', outputPath: null }));
    expect(state.updates[0]!.ids).toEqual([REPORT_A]);
    // Background work: every read and write runs in system scope, never contextless.
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('treats an already-missing file as removed and still expires the row', async () => {
    state.expiryPages = [[{ id: REPORT_A, outputPath: fileOf(REPORT_A) }]];

    const result = await expirePatchReportFiles({ now: NOW });

    expect(result).toEqual({ expired: 1, keptForRetry: 0 });
    expect(state.updates[0]!.set).toEqual(expect.objectContaining({ status: 'expired' }));
  });

  it('keeps the row untouched when the file cannot be removed, so the next run retries', async () => {
    // A directory at the file's path makes unlink fail with EISDIR/EPERM, not ENOENT.
    await mkdir(fileOf(REPORT_A));
    state.expiryPages = [[{ id: REPORT_A, outputPath: fileOf(REPORT_A) }]];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await expirePatchReportFiles({ now: NOW });

    expect(result).toEqual({ expired: 0, keptForRetry: 1 });
    expect(state.updates).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'patch_report_file_removal_failed' }),
    );
    errorSpy.mockRestore();
  });

  it('never unlinks an output path that is not the report\'s own file in the storage directory', async () => {
    const foreign = join(state.base, 'not-a-report.csv');
    await writeFile(foreign, 'keep me', 'utf8');
    // Correctly named, but reached by climbing out of the storage directory.
    const climbed = join(state.base, `${REPORT_B}.csv`);
    await writeFile(climbed, 'keep me too', 'utf8');
    state.expiryPages = [[
      { id: REPORT_A, outputPath: foreign },
      { id: REPORT_B, outputPath: `${state.root}/../${REPORT_B}.csv` },
    ]];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await expirePatchReportFiles({ now: NOW });

    expect(await exists(foreign)).toBe(true);
    expect(await exists(climbed)).toBe(true);
    expect(result.expired).toBe(2);
    expect(state.updates[0]!.set).toEqual(expect.objectContaining({ status: 'expired', outputPath: null }));
    warnSpy.mockRestore();
  });

  it('expires a whole page in one UPDATE, leaving out rows whose file could not be removed', async () => {
    await writeReport(fileOf(REPORT_A), 40);
    await mkdir(fileOf(REPORT_B)); // unlink fails with EISDIR/EPERM
    state.expiryPages = [[
      { id: REPORT_A, outputPath: fileOf(REPORT_A) },
      { id: REPORT_B, outputPath: fileOf(REPORT_B) },
      { id: REPORT_C, outputPath: fileOf(REPORT_C) }, // already gone
    ]];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await expirePatchReportFiles({ now: NOW });

    expect(result).toEqual({ expired: 2, keptForRetry: 1 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.ids).toEqual([REPORT_A, REPORT_C]);
    expect(state.contexts.filter((label) => label === 'patchReportRetention.expire')).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('pages through every expired row', async () => {
    await writeReport(fileOf(REPORT_A), 40);
    await writeReport(fileOf(REPORT_B), 40);
    state.expiryPages = [
      [{ id: REPORT_A, outputPath: fileOf(REPORT_A) }],
      [{ id: REPORT_B, outputPath: fileOf(REPORT_B) }],
      [],
    ];

    const result = await expirePatchReportFiles({ now: NOW, batchSize: 1 });

    expect(result.expired).toBe(2);
    expect(await exists(fileOf(REPORT_A))).toBe(false);
    expect(await exists(fileOf(REPORT_B))).toBe(false);
  });

  it('touches nothing when no report is past the window', async () => {
    await writeReport(fileOf(REPORT_A), 2);

    const result = await expirePatchReportFiles({ now: NOW });

    expect(result).toEqual({ expired: 0, keptForRetry: 0 });
    expect(await exists(fileOf(REPORT_A))).toBe(true);
    expect(state.updates).toHaveLength(0);
  });
});

describe('sweepOrphanedPatchReportFiles', () => {
  it('removes old files with no owning row and keeps referenced, recent and foreign files', async () => {
    await writeReport(fileOf(REPORT_A), 40); // orphan, old → removed
    await writeReport(fileOf(REPORT_B), 40); // still referenced → kept
    await writeFileAged(fileOf(REPORT_C), 10 * 60 * 1000); // orphan, but may be mid-generation → kept
    const foreign = join(state.root, 'notes.csv');
    await writeReport(foreign, 40); // not a report file name → never touched
    state.referencedRows = [{ id: REPORT_B }];

    const result = await sweepOrphanedPatchReportFiles({ now: NOW });

    expect(result).toEqual({ scanned: 2, removed: 1, failed: 0 });
    expect(await exists(fileOf(REPORT_A))).toBe(false);
    expect(await exists(fileOf(REPORT_B))).toBe(true);
    expect(await exists(fileOf(REPORT_C))).toBe(true);
    expect(await exists(foreign)).toBe(true);
    expect(state.contexts).toContain('patchReportRetention.orphanLookup');
  });

  it('removes an orphan once it is past the orphan floor, well inside the retention window', async () => {
    // E.g. an erased org's file whose unlink failed: its row is gone, so it
    // must not wait out the 30-day report window.
    await writeFileAged(fileOf(REPORT_A), 2 * HOUR_MS);

    const result = await sweepOrphanedPatchReportFiles({ now: NOW });

    expect(result.removed).toBe(1);
    expect(await exists(fileOf(REPORT_A))).toBe(false);
  });

  it('honours PATCH_REPORT_ORPHAN_MIN_AGE_MS for the orphan floor', async () => {
    process.env.PATCH_REPORT_ORPHAN_MIN_AGE_MS = String(3 * HOUR_MS);
    await writeFileAged(fileOf(REPORT_A), 2 * HOUR_MS);

    const result = await sweepOrphanedPatchReportFiles({ now: NOW });

    expect(result.removed).toBe(0);
    expect(await exists(fileOf(REPORT_A))).toBe(true);
  });

  it('does not follow a symlink named like a report file', async () => {
    const outside = join(state.base, 'outside.txt');
    await writeFile(outside, 'outside the storage dir', 'utf8');
    await symlink(outside, fileOf(REPORT_A));

    // Old enough to be swept if it were followed: `now` is ahead of its mtime.
    const result = await sweepOrphanedPatchReportFiles({ now: new Date(Date.now() + 60_000), minAgeMs: 0 });

    expect(result.removed).toBe(0);
    expect(await readFile(outside, 'utf8')).toBe('outside the storage dir');
  });

  it('does not descend into subdirectories', async () => {
    const nested = join(state.root, REPORT_B);
    await mkdir(nested);
    await writeReport(join(nested, `${REPORT_A}.csv`), 40);

    const result = await sweepOrphanedPatchReportFiles({ now: NOW });

    expect(result.scanned).toBe(0);
    expect(await exists(join(nested, `${REPORT_A}.csv`))).toBe(true);
  });

  it('sweeps a storage directory that is itself a symlink to the relocated directory', async () => {
    const elsewhere = join(state.base, 'elsewhere');
    await mkdir(elsewhere);
    await writeReport(join(elsewhere, `${REPORT_A}.csv`), 40);
    await writeReport(join(elsewhere, `${REPORT_B}.csv`), 40);
    await rm(state.root, { recursive: true, force: true });
    await symlink(elsewhere, state.root);
    state.referencedRows = [{ id: REPORT_B }];

    const result = await sweepOrphanedPatchReportFiles({ now: NOW });

    expect(result).toEqual({ scanned: 2, removed: 1, failed: 0 });
    expect(await exists(join(elsewhere, `${REPORT_A}.csv`))).toBe(false);
    expect(await exists(join(elsewhere, `${REPORT_B}.csv`))).toBe(true);
  });

  it('reports a storage path that is not a directory instead of skipping silently', async () => {
    await rm(state.root, { recursive: true, force: true });
    await writeFile(state.root, 'not a directory', 'utf8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sweepOrphanedPatchReportFiles({ now: NOW });

    expect(result).toEqual({ scanned: 0, removed: 0, failed: 1 });
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'patch_report_file_removal_failed' }),
    );
    errorSpy.mockRestore();
  });

  it('removes nothing when the row lookup fails (fails closed)', async () => {
    await writeReport(fileOf(REPORT_A), 40);
    state.lookupError = new Error('connection terminated');

    await expect(sweepOrphanedPatchReportFiles({ now: NOW })).rejects.toThrow('connection terminated');
    expect(await exists(fileOf(REPORT_A))).toBe(true);
  });

  it('is a no-op when the storage directory does not exist yet', async () => {
    await rm(state.root, { recursive: true, force: true });

    await expect(sweepOrphanedPatchReportFiles({ now: NOW })).resolves.toEqual(
      { scanned: 0, removed: 0, failed: 0 },
    );
  });
});

describe('runPatchReportRetentionOnce', () => {
  it('expires reports, then sweeps orphans, and logs the counts once', async () => {
    await writeReport(fileOf(REPORT_A), 40);
    await writeReport(fileOf(REPORT_B), 40);
    state.expiryPages = [[{ id: REPORT_A, outputPath: fileOf(REPORT_A) }]];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runPatchReportRetentionOnce({ now: NOW });

    expect(result.expired).toEqual({ expired: 1, keptForRetry: 0 });
    expect(result.orphans.removed).toBe(1);
    expect(await exists(fileOf(REPORT_B))).toBe(false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]![0]).toContain('expired 1');
    logSpy.mockRestore();
  });
});
