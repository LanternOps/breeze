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

const ROOT = join(process.env.TMPDIR ?? '/tmp', `breeze-patch-report-files-${process.pid}-${Math.random().toString(36).slice(2)}`);
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
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
});

afterAll(async () => {
  delete process.env.PATCH_REPORT_RETENTION_DAYS;
  await rm(ROOT, { recursive: true, force: true });
});

describe('patchReportRetentionDays', () => {
  it.each([
    [undefined, 30],
    ['', 30],
    ['abc', 30],
    ['7', 7],
    ['0', 1],
    ['-5', 1],
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
  it('accepts only an absolute path named after the report', () => {
    expect(patchReportFileFor(REPORT_A, `/data/patch-reports/${REPORT_A}.csv`)).toBe(`/data/patch-reports/${REPORT_A}.csv`);
    expect(patchReportFileFor(REPORT_A, `/data/patch-reports/${REPORT_B}.csv`)).toBeNull();
    expect(patchReportFileFor(REPORT_A, `data/patch-reports/${REPORT_A}.csv`)).toBeNull();
    expect(patchReportFileFor(REPORT_A, '/etc/passwd')).toBeNull();
    expect(patchReportFileFor(REPORT_A, null)).toBeNull();
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
