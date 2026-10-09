import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('./sentry', () => ({ captureMessage: vi.fn() }));

import {
  isPatchReportPastRetention,
  patchReportFileFor,
  patchReportRetentionDays,
  removePatchReportFiles,
} from './patchReportFiles';
import { captureMessage } from './sentry';

const BASE = join(process.env.TMPDIR ?? '/tmp', `breeze-patch-report-files-${process.pid}-${Math.random().toString(36).slice(2)}`);
const ROOT = join(BASE, 'patch-reports');
const REPORT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPORT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.PATCH_REPORT_RETENTION_DAYS;
  process.env.PATCH_REPORT_STORAGE_PATH = ROOT;
  await rm(BASE, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  delete process.env.PATCH_REPORT_RETENTION_DAYS;
  delete process.env.PATCH_REPORT_STORAGE_PATH;
  await rm(BASE, { recursive: true, force: true });
});

describe('patchReportRetentionDays', () => {
  it.each([
    [undefined, 30],
    ['', 30],
    ['abc', 30],
    ['7', 7],
    ['0', 1],
    ['-5', 1],
    // A prefix parse would read these as 5 and 0 and expire reports early;
    // they are not plain integers, so the default applies.
    ['5e1', 30],
    ['0x10', 30],
    [' 45 ', 45],
  ])('PATCH_REPORT_RETENTION_DAYS=%s → %d', (raw, expected) => {
    if (raw === undefined) delete process.env.PATCH_REPORT_RETENTION_DAYS;
    else process.env.PATCH_REPORT_RETENTION_DAYS = raw;
    expect(patchReportRetentionDays()).toBe(expected);
  });
});

describe('isPatchReportPastRetention', () => {
  const now = new Date('2026-10-09T12:00:00Z');

  it('measures from completion, falling back to creation', () => {
    const old = new Date(now.getTime() - 31 * DAY_MS);
    const recent = new Date(now.getTime() - 29 * DAY_MS);
    expect(isPatchReportPastRetention({ completedAt: old, createdAt: old }, now)).toBe(true);
    expect(isPatchReportPastRetention({ completedAt: recent, createdAt: old }, now)).toBe(false);
    expect(isPatchReportPastRetention({ completedAt: null, createdAt: old }, now)).toBe(true);
    expect(isPatchReportPastRetention({ completedAt: null, createdAt: recent }, now)).toBe(false);
  });
});

describe('patchReportFileFor', () => {
  it('accepts only the report\'s own file directly inside the storage directory', () => {
    expect(patchReportFileFor(REPORT_A, join(ROOT, `${REPORT_A}.csv`))).toBe(join(ROOT, `${REPORT_A}.csv`));
    expect(patchReportFileFor(REPORT_A, join(ROOT, `${REPORT_B}.csv`))).toBeNull();
    expect(patchReportFileFor(REPORT_A, `patch-reports/${REPORT_A}.csv`)).toBeNull();
    expect(patchReportFileFor(REPORT_A, '/etc/passwd')).toBeNull();
    expect(patchReportFileFor(REPORT_A, null)).toBeNull();
  });

  it('refuses a correctly named file outside the storage directory', () => {
    expect(patchReportFileFor(REPORT_A, `/srv/${REPORT_A}.csv`)).toBeNull();
    expect(patchReportFileFor(REPORT_A, join(ROOT, 'nested', `${REPORT_A}.csv`))).toBeNull();
  });

  it('refuses a path that climbs out of the storage directory with ..', () => {
    expect(patchReportFileFor(REPORT_A, `${ROOT}/../../srv/${REPORT_A}.csv`)).toBeNull();
    // Even when it normalises back into the storage directory.
    expect(patchReportFileFor(REPORT_A, `${ROOT}/../patch-reports/${REPORT_A}.csv`)).toBeNull();
  });
});

describe('removePatchReportFiles', () => {
  it('removes report files, tolerates missing ones, and never touches a foreign path', async () => {
    const fileA = join(ROOT, `${REPORT_A}.csv`);
    const foreign = join(ROOT, 'keep.csv');
    await writeFile(fileA, 'x', 'utf8');
    await writeFile(foreign, 'x', 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await removePatchReportFiles([
      { id: REPORT_A, outputPath: fileA },
      { id: REPORT_B, outputPath: join(ROOT, `${REPORT_B}.csv`) },
      { id: REPORT_B, outputPath: foreign },
    ], 'test');

    expect(result).toEqual({ removed: 1, missing: 1, failed: 0, unresolvable: 1 });
    expect(await exists(fileA)).toBe(false);
    expect(await exists(foreign)).toBe(true);
    warnSpy.mockRestore();
  });

  it('never removes a correctly named file outside the storage directory', async () => {
    const outside = join(BASE, `${REPORT_A}.csv`);
    await writeFile(outside, 'x', 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await removePatchReportFiles([
      { id: REPORT_A, outputPath: `${ROOT}/../${REPORT_A}.csv` },
      { id: REPORT_A, outputPath: outside },
    ], 'test');

    expect(result).toEqual({ removed: 0, missing: 0, failed: 0, unresolvable: 2 });
    expect(await exists(outside)).toBe(true);
    expect(captureMessage).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs and reports a failed removal without throwing', async () => {
    const dirAtPath = join(ROOT, `${REPORT_A}.csv`);
    await mkdir(dirAtPath);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await removePatchReportFiles([{ id: REPORT_A, outputPath: dirAtPath }], 'test');

    expect(result.failed).toBe(1);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'patch_report_file_removal_failed' }),
    );
    errorSpy.mockRestore();
  });
});
