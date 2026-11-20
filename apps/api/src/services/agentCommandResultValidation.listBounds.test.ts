import { describe, expect, it } from 'vitest';
import {
  backupVerificationStructuredResultSchema,
  restoreStructuredResultSchema,
  validateCriticalCommandResult,
  CRITICAL_RESULT_FAILED_FILES_MAX,
  CRITICAL_RESULT_WARNINGS_MAX,
  CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS,
  CRITICAL_RESULT_STRUCTURED_MAX_BYTES,
} from './agentCommandResultValidation';

// Agents already in the field do not bound verify / test-restore / restore
// lists to the server's limits. One entry over a list limit, or a body over the
// structured-size cap, used to reject the WHOLE result — so a large run with
// many failures was recorded as a malformed-result failure and lost its counts.
// The server now keeps the first entries, records how many it dropped, and
// keeps every count.

const path = (i: number) =>
  `C:\\Users\\jdoe\\Documents\\Projects\\Quarterly Reports\\2026\\archive\\scan_${String(i).padStart(6, '0')}_final_v2.pdf`;
const paths = (n: number) => Array.from({ length: n }, (_, i) => path(i));
const warningTexts = (n: number) =>
  Array.from({ length: n }, (_, i) => `size mismatch on volatile entry ${path(i)} (expected 1024, got 2048)`);

const codePoints = (s: string) => [...s].length;

function expectWithinLimits(structured: Record<string, unknown>, serializedBytes: number) {
  const failedFiles = structured.failedFiles as string[];
  const warnings = structured.warnings as string[];
  expect(failedFiles.length).toBeLessThanOrEqual(CRITICAL_RESULT_FAILED_FILES_MAX);
  expect(warnings.length).toBeLessThanOrEqual(CRITICAL_RESULT_WARNINGS_MAX);
  for (const entry of [...failedFiles, ...warnings]) {
    expect(codePoints(entry)).toBeLessThanOrEqual(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS);
  }
  expect(serializedBytes).toBeLessThanOrEqual(CRITICAL_RESULT_STRUCTURED_MAX_BYTES);
}

describe('agentCommandResultValidation — oversize detail lists from shipped agents', () => {
  it('accepts a WebSocket verify result with 5,000 failed files and 500 warnings, keeping the counts', () => {
    const body = {
      snapshotId: 'snap-1',
      status: 'failed',
      filesVerified: 120_000,
      filesFailed: 5_000,
      filesUnchecked: 12,
      sizeBytes: 10_000_000,
      durationMs: 1000,
      failedFiles: paths(5_000),
      warnings: warningTexts(500),
    };
    const stdout = JSON.stringify(body);
    // The fixture must be over the structured cap, or it would only exercise
    // the list-count limit.
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(CRITICAL_RESULT_STRUCTURED_MAX_BYTES);

    // The WebSocket leg carries the body twice: as stdout and parsed as result.
    const validated = validateCriticalCommandResult('backup_verify', {
      commandId: 'cmd-1',
      status: 'completed',
      stdout,
      result: body,
    });
    expect(validated).not.toBeNull();
    const structured = validated!.structuredResult;
    expect(structured).toMatchObject({ status: 'failed', filesVerified: 120_000, filesFailed: 5_000, filesUnchecked: 12 });
    expectWithinLimits(structured, validated!.serializedResultBytes);

    const failedFiles = structured.failedFiles as string[];
    expect(failedFiles.length).toBeGreaterThan(0);
    expect(failedFiles[0]).toBe(path(0));
    expect(failedFiles.length + (structured.failedFilesOmitted as number)).toBe(5_000);
    // The normalized stdout is what the verification handler re-parses.
    expect(backupVerificationStructuredResultSchema.safeParse(JSON.parse(validated!.normalizedStdout!)).success).toBe(true);
  });

  it('accepts an HTTP restore result (stdout only) with oversize lists, keeping the counts', () => {
    const body = {
      snapshotId: 'snap-1',
      status: 'partial',
      filesRestored: 40_000,
      filesFailed: 5_000,
      failedFiles: paths(5_000),
      warnings: warningTexts(500),
      error: 'x'.repeat(25_000),
    };
    const validated = validateCriticalCommandResult('backup_restore', {
      commandId: 'cmd-2',
      status: 'completed',
      stdout: JSON.stringify(body),
    });
    const structured = validated!.structuredResult;
    expect(structured).toMatchObject({ status: 'partial', filesRestored: 40_000, filesFailed: 5_000 });
    expectWithinLimits(structured, validated!.serializedResultBytes);
    expect((structured.error as string).length).toBeLessThanOrEqual(10_000);
  });

  it('shrinks lists that are within the count limits but over the structured byte cap', () => {
    const long = Array.from({ length: CRITICAL_RESULT_FAILED_FILES_MAX }, (_, i) =>
      `/srv/share/${'deep-directory/'.repeat(180)}file_${i}.bin`);
    const body = { status: 'failed', filesFailed: long.length, failedFiles: long };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(CRITICAL_RESULT_STRUCTURED_MAX_BYTES);
    const validated = validateCriticalCommandResult('backup_test_restore', {
      commandId: 'cmd-3',
      status: 'completed',
      result: body,
    });
    const structured = validated!.structuredResult;
    expect(structured.filesFailed).toBe(long.length);
    const kept = structured.failedFiles as string[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length + (structured.failedFilesOmitted as number)).toBe(long.length);
    expect(validated!.serializedResultBytes).toBeLessThanOrEqual(CRITICAL_RESULT_STRUCTURED_MAX_BYTES);
  });

  it('bounds lists on a direct schema parse (the scheduled verification handler re-parses stdout)', () => {
    const r = backupVerificationStructuredResultSchema.safeParse({
      status: 'failed',
      filesFailed: 1_500,
      failedFiles: [...paths(1_499), ''],
      warnings: ['y'.repeat(5_000)],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as Record<string, unknown>;
      expect((data.failedFiles as string[]).length).toBe(CRITICAL_RESULT_FAILED_FILES_MAX);
      expect(data.failedFilesOmitted).toBe(499);
      expect(codePoints((data.warnings as string[])[0])).toBeLessThanOrEqual(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS);
      expect(data.filesFailed).toBe(1_500);
    }
  });

  it('counts an over-long multi-byte entry in code points', () => {
    const r = restoreStructuredResultSchema.safeParse({ failedFiles: ['目录'.repeat(3_000)] });
    expect(r.success).toBe(true);
    if (r.success) {
      const entry = (r.data.failedFiles as string[])[0];
      expect(codePoints(entry)).toBeLessThanOrEqual(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS);
      expect(entry.startsWith('目录')).toBe(true);
    }
  });

  it('adds to an omitted count the agent already reported', () => {
    const r = backupVerificationStructuredResultSchema.safeParse({
      status: 'failed',
      filesFailed: 3_000,
      failedFiles: paths(1_200),
      failedFilesOmitted: 1_800,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const data = r.data as Record<string, unknown>;
      expect((data.failedFiles as string[]).length + (data.failedFilesOmitted as number)).toBe(3_000);
    }
  });

  it('leaves a result that is within every limit unchanged', () => {
    const body = { status: 'failed', filesFailed: 2, failedFiles: paths(2), warnings: warningTexts(3) };
    const validated = validateCriticalCommandResult('backup_verify', {
      commandId: 'cmd-4',
      status: 'completed',
      stdout: JSON.stringify(body),
    });
    expect(validated!.structuredResult).toEqual(body);
  });

  it('keeps a numeric failedFiles (bmr_recover) untouched', () => {
    const r = restoreStructuredResultSchema.safeParse({ status: 'completed', failedFiles: 7 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.failedFiles).toBe(7);
  });
});
