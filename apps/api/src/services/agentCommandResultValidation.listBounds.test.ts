import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupVerificationStructuredResultSchema,
  restoreStructuredResultSchema,
  validateCriticalCommandResult,
  boundCriticalResultLists,
  CRITICAL_RESULT_FAILED_FILES_MAX,
  CRITICAL_RESULT_WARNINGS_MAX,
  CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS,
  CRITICAL_RESULT_STRUCTURED_MAX_BYTES,
  CRITICAL_RESULT_STDOUT_MAX_BYTES,
  CRITICAL_RESULT_WARNING_TEXT_MAX_CHARS,
  CRITICAL_RESULT_ERROR_MAX_CHARS,
  CRITICAL_RESULT_BOUNDING_MAX_BYTES,
  RESTORE_QUARANTINED_PATHS_MAX,
} from './agentCommandResultValidation';
import { MAX_COMMAND_RESULT_BYTES } from '../routes/agents/schemas';
import { RESTORE_TARGET_PATH_MAX_LENGTH } from '@breeze/shared';

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
      expect(codePoints((data.warnings as string[])[0]!)).toBeLessThanOrEqual(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS);
      expect(data.filesFailed).toBe(1_500);
    }
  });

  it('counts an over-long multi-byte entry in code points', () => {
    const r = restoreStructuredResultSchema.safeParse({ failedFiles: ['目录'.repeat(3_000)] });
    expect(r.success).toBe(true);
    if (r.success) {
      const entry = (r.data.failedFiles as string[])[0]!;
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

describe('agentCommandResultValidation — bounding work is capped (resource-cap ordering)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pins the limits the agent mirrors (agent/internal/wire/critical_result_limits.go)', () => {
    // Changing one of these needs the Go mirror changed in the same commit.
    expect(CRITICAL_RESULT_FAILED_FILES_MAX).toBe(1000);
    expect(CRITICAL_RESULT_WARNINGS_MAX).toBe(100);
    expect(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS).toBe(4096);
    expect(CRITICAL_RESULT_WARNING_TEXT_MAX_CHARS).toBe(10_000);
    expect(CRITICAL_RESULT_ERROR_MAX_CHARS).toBe(10_000);
    expect(CRITICAL_RESULT_STRUCTURED_MAX_BYTES).toBe(524_288);
    expect(RESTORE_QUARANTINED_PATHS_MAX).toBe(100);
  });

  it('never bounds a body larger than the general command_result cap', () => {
    expect(CRITICAL_RESULT_BOUNDING_MAX_BYTES).toBeLessThanOrEqual(MAX_COMMAND_RESULT_BYTES);
  });

  it('rejects a body over the bounding ceiling without parsing it', () => {
    const stdout = JSON.stringify({
      status: 'failed',
      filesFailed: 1,
      failedFiles: ['x'.repeat(CRITICAL_RESULT_BOUNDING_MAX_BYTES)],
    });
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => validateCriticalCommandResult('backup_verify', { commandId: 'cmd-big', status: 'completed', stdout }))
      .toThrow(/stdout exceeds/);
    expect(parse).not.toHaveBeenCalled();
  });

  it('bounds a body just under the ceiling without re-encoding it per pass', () => {
    const entries = Array.from({ length: CRITICAL_RESULT_FAILED_FILES_MAX }, (_, i) =>
      `/srv/share/${'deep-directory/'.repeat(270)}file_${i}.bin`);
    const stdout = JSON.stringify({ status: 'failed', filesFailed: entries.length, failedFiles: entries });
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(CRITICAL_RESULT_BOUNDING_MAX_BYTES * 0.8);
    expect(Buffer.byteLength(stdout)).toBeLessThan(CRITICAL_RESULT_BOUNDING_MAX_BYTES);

    const realStringify = JSON.stringify;
    let stringifiedBytes = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const out = realStringify(...args);
      stringifiedBytes += typeof out === 'string' ? out.length : 0;
      return out;
    });
    const validated = validateCriticalCommandResult('backup_verify', { commandId: 'cmd-near', status: 'completed', stdout });
    vi.restoreAllMocks();

    const structured = validated!.structuredResult;
    expect(structured.filesFailed).toBe(entries.length);
    expect((structured.failedFiles as string[]).length).toBeGreaterThan(0);
    // stdout alone: bounded to the stdout cap the size check applies to it.
    expect(validated!.serializedResultBytes).toBeLessThanOrEqual(CRITICAL_RESULT_STDOUT_MAX_BYTES);
    // A few encodes of the bounded (<= 1 MiB) body, not an encode of the
    // multi-megabyte body per halving pass (that measured ~8.7 MB here).
    expect(stringifiedBytes).toBeLessThan(4 * CRITICAL_RESULT_STDOUT_MAX_BYTES);
  });

  it('rejects, without shrinking the lists, a body whose non-list part alone is over the cap', () => {
    const body = {
      status: 'failed',
      filesFailed: 5_000,
      failedFiles: paths(5_000),
      extra: 'z'.repeat(CRITICAL_RESULT_STRUCTURED_MAX_BYTES + 1),
    };
    expect(() => validateCriticalCommandResult('backup_verify', {
      commandId: 'cmd-extra', status: 'completed', result: body,
    })).toThrow(/structured result exceeds/);

    // The lists are count-bounded, not cut further: cutting cannot make the
    // body fit, so it would only lose detail.
    const bounded = boundCriticalResultLists(body, {
      maxBytes: CRITICAL_RESULT_STRUCTURED_MAX_BYTES,
      encodedBytes: Buffer.byteLength(JSON.stringify(body)),
    }) as Record<string, unknown>;
    expect((bounded.failedFiles as string[]).length).toBe(CRITICAL_RESULT_FAILED_FILES_MAX);
    expect(bounded.failedFilesOmitted).toBe(5_000 - CRITICAL_RESULT_FAILED_FILES_MAX);
  });

  it('truncates a multi-megabyte entry by code points without changing its prefix', () => {
    const r = backupVerificationStructuredResultSchema.safeParse({
      status: 'failed',
      error: '目'.repeat(2_000_000),
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const error = (r.data as Record<string, unknown>).error as string;
      expect(codePoints(error)).toBe(CRITICAL_RESULT_ERROR_MAX_CHARS);
      expect(error.endsWith('…')).toBe(true);
    }
  });

  it('bounds a long restricted-descriptor path list before the size check', () => {
    const quarantined = Array.from({ length: 20_000 }, (_, i) => `C:\\Data\\Shared\\Finance\\ledger_${i}.xlsx`);
    const body = {
      status: 'completed',
      filesRestored: 20_000,
      filesFailed: 3,
      failedFiles: paths(3),
      securityDescriptorQuarantined: 20_000,
      securityDescriptorQuarantinedPaths: quarantined,
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(CRITICAL_RESULT_STRUCTURED_MAX_BYTES);
    const validated = validateCriticalCommandResult('backup_restore', {
      commandId: 'cmd-sd', status: 'completed', result: body,
    });
    const structured = validated!.structuredResult;
    expect(structured.failedFiles).toEqual(paths(3));
    expect(structured.securityDescriptorQuarantined).toBe(20_000);
    expect((structured.securityDescriptorQuarantinedPaths as string[]).length).toBe(RESTORE_QUARANTINED_PATHS_MAX);
  });
});

describe('agentCommandResultValidation — trimming never loosens other checks', () => {
  it('still rejects a restricted-descriptor path list holding non-strings', () => {
    expect(restoreStructuredResultSchema.safeParse({
      status: 'completed',
      securityDescriptorQuarantinedPaths: [1, 'a', { x: 1 }],
    }).success).toBe(false);
  });

  it('cuts a restricted-descriptor path on a code-point boundary (no lone surrogate)', () => {
    // 1023 ASCII characters then an astral character: a UTF-16 cut at 1024
    // would keep only its high surrogate.
    const path = `${'p'.repeat(1_023)}😀tail`;
    const r = restoreStructuredResultSchema.safeParse({
      status: 'completed',
      securityDescriptorQuarantined: 1,
      securityDescriptorQuarantinedPaths: [path],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const kept = (r.data.securityDescriptorQuarantinedPaths as string[])[0]!;
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(kept)).toBe(false);
      expect(codePoints(kept)).toBeLessThanOrEqual(1_024);
    }
  });

  it('does not let a trimmed result replace an oversize stdout that is a different document', () => {
    const body = { status: 'failed', filesFailed: 5_000, failedFiles: paths(5_000) };
    expect(() => validateCriticalCommandResult('backup_verify', {
      commandId: 'cmd-unrelated-stdout',
      status: 'completed',
      stdout: 'x'.repeat(CRITICAL_RESULT_STDOUT_MAX_BYTES + 1),
      result: body,
    })).toThrow(/stdout exceeds/);
  });

  it('still salvages a WebSocket result whose stdout is the same document', () => {
    const body = { status: 'failed', filesFailed: 12_000, failedFiles: paths(12_000) };
    const stdout = JSON.stringify(body);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(CRITICAL_RESULT_STDOUT_MAX_BYTES);
    // Different key order, as Go's re-marshal of the parsed body produces.
    const result = { failedFiles: body.failedFiles, filesFailed: body.filesFailed, status: body.status };
    const validated = validateCriticalCommandResult('backup_verify', {
      commandId: 'cmd-same-doc', status: 'completed', stdout, result,
    });
    expect(validated!.structuredResult.filesFailed).toBe(12_000);
  });
});

// #12736: the folder a file restore wrote under. Bounded like the target path
// a request may carry, which the helper echoes back unchanged.
describe('agentCommandResultValidation — restoredTo', () => {
  it('accepts a restoredTo as long as the longest target path a request may carry', () => {
    const restoredTo = `D:\\${'r'.repeat(RESTORE_TARGET_PATH_MAX_LENGTH - 3)}`;
    const r = restoreStructuredResultSchema.safeParse({ status: 'completed', restoredTo });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.restoredTo).toBe(restoredTo);
  });

  it('rejects a restoredTo that is not a string', () => {
    expect(restoreStructuredResultSchema.safeParse({ status: 'completed', restoredTo: 7 }).success).toBe(false);
  });

  it('rejects a restoredTo longer than any target path a request may carry', () => {
    expect(restoreStructuredResultSchema.safeParse({
      status: 'completed',
      restoredTo: 'r'.repeat(RESTORE_TARGET_PATH_MAX_LENGTH + 1),
    }).success).toBe(false);
  });
});
