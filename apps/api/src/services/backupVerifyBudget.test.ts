import { describe, expect, it } from 'vitest';
import {
  BACKUP_VERIFY_BASE_BUDGET_MS,
  BACKUP_VERIFY_MAX_BUDGET_MS,
  backupVerifyBudgetMsFromPayloadValue,
  computeBackupVerifyBudgetSeconds,
} from './backupVerifyBudget';

const HOUR_S = 60 * 60;
const GIB = 1024 * 1024 * 1024;

describe('computeBackupVerifyBudgetSeconds', () => {
  it('pins the base and ceiling', () => {
    expect(BACKUP_VERIFY_BASE_BUDGET_MS).toBe(2 * HOUR_S * 1000);
    expect(BACKUP_VERIFY_MAX_BUDGET_MS).toBe(12 * HOUR_S * 1000);
  });

  it('uses the 2h base when neither count is known', () => {
    expect(computeBackupVerifyBudgetSeconds({})).toBe(2 * HOUR_S);
    expect(computeBackupVerifyBudgetSeconds({ fileCount: null, sizeBytes: null })).toBe(2 * HOUR_S);
  });

  it('treats zero, negative and non-finite counts as unknown', () => {
    expect(computeBackupVerifyBudgetSeconds({ fileCount: 0, sizeBytes: 0 })).toBe(2 * HOUR_S);
    expect(computeBackupVerifyBudgetSeconds({ fileCount: -5, sizeBytes: Number.NaN })).toBe(2 * HOUR_S);
    expect(computeBackupVerifyBudgetSeconds({ fileCount: Number.POSITIVE_INFINITY })).toBe(2 * HOUR_S);
  });

  it('never goes below the 2h floor for a tiny snapshot', () => {
    expect(computeBackupVerifyBudgetSeconds({ fileCount: 10, sizeBytes: 1024 })).toBe(2 * HOUR_S);
  });

  // The reported case: ~525k files / 10 GiB verifying at 3–4.5k files/min.
  // ceil(525000 / 1500) = 350 min, 10 GiB at 4 MiB/s = 2560 s ≈ 42.7 min,
  // 392.7 min rounded up to a whole 5 minutes = 395 min (6 h 35 m).
  it('gives 525,000 files + 10 GiB 395 minutes', () => {
    expect(computeBackupVerifyBudgetSeconds({ fileCount: 525_000, sizeBytes: 10 * GIB })).toBe(395 * 60);
  });

  it('rounds up to a whole 5 minutes', () => {
    // 200k files = 133.3 → 134 min of files; no bytes → 135 min.
    expect(computeBackupVerifyBudgetSeconds({ fileCount: 200_000 })).toBe(135 * 60);
    expect(computeBackupVerifyBudgetSeconds({ fileCount: 200_000 }) % 300).toBe(0);
  });

  it('uses each count on its own when only one is known', () => {
    // 50 GiB at 4 MiB/s = 12800 s ≈ 213.3 min → 215 min.
    expect(computeBackupVerifyBudgetSeconds({ sizeBytes: 50 * GIB })).toBe(215 * 60);
    expect(computeBackupVerifyBudgetSeconds({ fileCount: 300_000, sizeBytes: null })).toBe(200 * 60);
  });

  it('caps a huge snapshot at 12h', () => {
    expect(computeBackupVerifyBudgetSeconds({ fileCount: 5_000_000, sizeBytes: 2000 * GIB })).toBe(12 * HOUR_S);
  });

  it('always returns an integer', () => {
    for (const fileCount of [1, 1499, 1501, 333_333, 777_777]) {
      expect(Number.isInteger(computeBackupVerifyBudgetSeconds({ fileCount, sizeBytes: fileCount * 12_345 }))).toBe(true);
    }
  });
});

describe('backupVerifyBudgetMsFromPayloadValue', () => {
  it('falls back to the 2h base for an absent or invalid value', () => {
    for (const value of [undefined, null, 'x', '7200', Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
      expect(backupVerifyBudgetMsFromPayloadValue(value)).toBe(BACKUP_VERIFY_BASE_BUDGET_MS);
    }
  });

  it('clamps to [2h, 12h]', () => {
    expect(backupVerifyBudgetMsFromPayloadValue(60)).toBe(BACKUP_VERIFY_BASE_BUDGET_MS);
    expect(backupVerifyBudgetMsFromPayloadValue(-1)).toBe(BACKUP_VERIFY_BASE_BUDGET_MS);
    expect(backupVerifyBudgetMsFromPayloadValue(395 * 60)).toBe(395 * 60 * 1000);
    expect(backupVerifyBudgetMsFromPayloadValue(48 * HOUR_S)).toBe(BACKUP_VERIFY_MAX_BUDGET_MS);
  });
});
