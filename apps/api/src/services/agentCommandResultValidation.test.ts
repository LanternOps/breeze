import { describe, expect, it } from 'vitest';
import {
  restoreStructuredResultSchema,
  backupVerificationStructuredResultSchema,
  vaultSyncStructuredResultSchema,
} from './agentCommandResultValidation';

// The agent-reported byte totals use .refine(Number.isInteger) rather than .int()
// so v4's new 2^53 cap doesn't reject large uint64 counters. These run on the
// critical-command .parse() path (validateCriticalCommandResult), where a reject
// records an actually-successful backup/restore/vault-sync as FAILED. A revert to
// .int() would throw on >2^53 and pass every other existing test. 2^54 is above
// Number.MAX_SAFE_INTEGER (2^53).
const BIG = 18_014_398_509_481_984;

describe('agentCommandResultValidation — large byte totals (v4 .int() 2^53 cap)', () => {
  it('accepts bytesRestored above 2^53', () => {
    const r = restoreStructuredResultSchema.safeParse({ bytesRestored: BIG });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.bytesRestored).toBe(BIG);
  });

  it('accepts sizeBytes above 2^53', () => {
    const r = backupVerificationStructuredResultSchema.safeParse({ status: 'passed', sizeBytes: BIG });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sizeBytes).toBe(BIG);
  });

  it('accepts totalBytes above 2^53', () => {
    const r = vaultSyncStructuredResultSchema.safeParse({ totalBytes: BIG });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.totalBytes).toBe(BIG);
  });

  it('still rejects a fractional byte total (refine integer check intact)', () => {
    expect(restoreStructuredResultSchema.safeParse({ bytesRestored: 1.5 }).success).toBe(false);
  });
});
