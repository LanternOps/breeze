import { describe, expect, it } from 'vitest';
import {
  restoreStructuredResultSchema,
  backupVerificationStructuredResultSchema,
  vaultSyncStructuredResultSchema,
  RESTORE_QUARANTINED_PATHS_MAX,
  RESTORE_QUARANTINED_PATH_MAX_CHARS,
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

describe('agentCommandResultValidation — bare_metal_rebuild terminal statuses (W05a)', () => {
  // The helper's exec_bare_metal_rebuild posts a REFUSED preflight as a
  // successful command whose result status is "refused" (the server maps
  // it). Rejecting it as malformed turns every refusal into a FAILED command
  // with an unreadable zod dump instead of the refusal reason.
  it('accepts a refused rebuild result', () => {
    const parsed = restoreStructuredResultSchema.parse({
      status: 'refused',
      phaseReached: 'preflight',
      refusal: 'not enough free space for raw image plus VHDX: need 3, have 2',
      target: { kind: 'vhdx', path: '/mnt/rebuild/out.vhdx' },
    });
    expect(parsed.status).toBe('refused');
  });
});

describe('agentCommandResultValidation — restore result details (restricted descriptors, result code)', () => {
  it('accepts the restricted-descriptor count and path list', () => {
    const r = restoreStructuredResultSchema.safeParse({
      status: 'completed',
      securityDescriptorQuarantined: 2,
      securityDescriptorQuarantinedPaths: ['C:\\Data\\a.txt', 'C:\\Data\\b.txt'],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.securityDescriptorQuarantined).toBe(2);
      expect(r.data.securityDescriptorQuarantinedPaths).toEqual(['C:\\Data\\a.txt', 'C:\\Data\\b.txt']);
    }
  });

  it('keeps a result from a helper that reports neither field unchanged', () => {
    const r = restoreStructuredResultSchema.safeParse({ status: 'completed', filesRestored: 3 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('securityDescriptorQuarantined');
      expect(r.data).not.toHaveProperty('securityDescriptorQuarantinedPaths');
    }
  });

  it('bounds a long path list instead of rejecting the whole restore result', () => {
    const paths = Array.from({ length: 5_000 }, (_, i) => `C:\\Users\\u\\file_${i}.docx`);
    const r = restoreStructuredResultSchema.safeParse({
      status: 'completed',
      securityDescriptorQuarantined: 5_000,
      securityDescriptorQuarantinedPaths: paths,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.securityDescriptorQuarantined).toBe(5_000);
      expect(r.data.securityDescriptorQuarantinedPaths).toHaveLength(RESTORE_QUARANTINED_PATHS_MAX);
      expect(r.data.securityDescriptorQuarantinedPaths?.[0]).toBe(paths[0]);
    }
  });

  it('truncates an over-long path entry', () => {
    const r = restoreStructuredResultSchema.safeParse({
      securityDescriptorQuarantined: 1,
      securityDescriptorQuarantinedPaths: ['x'.repeat(5_000)],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.securityDescriptorQuarantinedPaths?.[0]).toHaveLength(RESTORE_QUARANTINED_PATH_MAX_CHARS);
    }
  });

  it('rejects a negative or fractional restricted-descriptor count', () => {
    expect(restoreStructuredResultSchema.safeParse({ securityDescriptorQuarantined: -1 }).success).toBe(false);
    expect(restoreStructuredResultSchema.safeParse({ securityDescriptorQuarantined: 1.5 }).success).toBe(false);
  });

  it('accepts a short recovery result code and rejects an over-long one', () => {
    const ok = restoreStructuredResultSchema.safeParse({ status: 'completed', code: 'system_state_requires_rebuild' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.code).toBe('system_state_requires_rebuild');
    expect(restoreStructuredResultSchema.safeParse({ code: 'x'.repeat(65) }).success).toBe(false);
  });
});
