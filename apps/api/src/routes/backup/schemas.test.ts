import { describe, expect, it } from 'vitest';
import { bmrCompleteSchema, bmrVmRestoreSchema, canonicalizeS3CredentialFields, jobListSchema } from './schemas';

// D14: a bare-metal recovery completion report was answering "Request body
// too large" for a payload carrying ~9,900 unbounded `warnings` strings (the
// agent-side helper is being fixed to cap that list at 51 entries, but the
// schema itself had no bound at all). These caps give the API-side contract a
// hard, well-defined ceiling regardless of what any given agent version sends.
describe('bmrCompleteSchema — completion report caps (D14)', () => {
  const baseResult = { status: 'completed' as const };

  it('rejects a warnings array over 200 entries', () => {
    const warnings = Array.from({ length: 201 }, (_, i) => `warning-${i}`);
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a warnings array of exactly 200 entries', () => {
    const warnings = Array.from({ length: 200 }, (_, i) => `warning-${i}`);
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a single warning string over 2000 characters', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings: ['x'.repeat(2001)] },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a warning string of exactly 2000 characters', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings: ['x'.repeat(2000)] },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional non-negative integer failedFiles', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, failedFiles: 42 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.failedFiles).toBe(42);
  });

  it('rejects a negative failedFiles', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, failedFiles: -1 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer failedFiles', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, failedFiles: 1.5 },
    });
    expect(parsed.success).toBe(false);
  });

  it('leaves failedFiles undefined when the agent omits it (legacy agent)', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.failedFiles).toBeUndefined();
  });
});

describe('bmrVmRestoreSchema — engine discriminated union (W05a)', () => {
  const SNAP = '11111111-1111-4111-8111-111111111111';
  const DEV = '22222222-2222-4222-8222-222222222222';

  it('defaults a payload without engine to the Hyper-V variant', () => {
    const parsed = bmrVmRestoreSchema.safeParse({ snapshotId: SNAP, targetDeviceId: DEV, hypervisor: 'hyperv', vmName: 'VM' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.engine).toBe('hyperv');
  });

  it('accepts an explicit hyperv engine with the existing fields', () => {
    const parsed = bmrVmRestoreSchema.safeParse({
      engine: 'hyperv', snapshotId: SNAP, targetDeviceId: DEV, hypervisor: 'hyperv', vmName: 'VM', switchName: 'sw', vmSpecs: { memoryMb: 1024 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the rebuild variant and rejects identity, vm fields, relative and non-vhdx paths', () => {
    const ok = bmrVmRestoreSchema.safeParse({ engine: 'rebuild', snapshotId: SNAP, rebuildHostDeviceId: DEV, outputPath: '/srv/out.vhdx', imageSizeGb: 40 });
    expect(ok.success).toBe(true);
    expect(bmrVmRestoreSchema.safeParse({ engine: 'rebuild', snapshotId: SNAP, rebuildHostDeviceId: DEV, outputPath: '/srv/out.vhdx', identity: 'original' }).success).toBe(false);
    expect(bmrVmRestoreSchema.safeParse({ engine: 'rebuild', snapshotId: SNAP, rebuildHostDeviceId: DEV, outputPath: '/srv/out.vhdx', vmName: 'x' }).success).toBe(false);
    expect(bmrVmRestoreSchema.safeParse({ engine: 'rebuild', snapshotId: SNAP, rebuildHostDeviceId: DEV, outputPath: 'srv/out.vhdx' }).success).toBe(false);
    expect(bmrVmRestoreSchema.safeParse({ engine: 'rebuild', snapshotId: SNAP, rebuildHostDeviceId: DEV, outputPath: '/srv/out.img' }).success).toBe(false);
    expect(bmrVmRestoreSchema.safeParse({ engine: 'rebuild', snapshotId: SNAP, outputPath: '/srv/out.vhdx' }).success).toBe(false);
  });

  it('rejects an unknown engine', () => {
    expect(bmrVmRestoreSchema.safeParse({ engine: 'vmware', snapshotId: SNAP, targetDeviceId: DEV, hypervisor: 'hyperv', vmName: 'VM' }).success).toBe(false);
  });
});

// #6511: direct unit coverage for canonicalizeS3CredentialFields — the
// indirect coverage through configs.ts/backupProviderConfig.ts proves the
// end-to-end regression is fixed, but doesn't pin down this function's own
// precedence rule (review finding: no test anywhere exercised both
// spellings present at once on the API side, even though the equivalent Go
// agent case is table-tested).
describe('canonicalizeS3CredentialFields', () => {
  it('canonical spelling wins when both spellings are present', () => {
    const details: Record<string, unknown> = {
      accessKey: 'AK', secretKey: 'SK',
      accessKeyId: 'AKID', secretAccessKey: 'SAK',
    };
    canonicalizeS3CredentialFields(details);
    expect(details.accessKey).toBe('AK');
    expect(details.secretKey).toBe('SK');
    expect(details.accessKeyId).toBeUndefined();
    expect(details.secretAccessKey).toBeUndefined();
  });

  it('falls back to the AWS-idiomatic spelling when canonical is absent', () => {
    const details: Record<string, unknown> = { accessKeyId: 'AKID', secretAccessKey: 'SAK' };
    canonicalizeS3CredentialFields(details);
    expect(details.accessKey).toBe('AKID');
    expect(details.secretKey).toBe('SAK');
    expect(details.accessKeyId).toBeUndefined();
    expect(details.secretAccessKey).toBeUndefined();
  });

  it('is a no-op when neither spelling is present', () => {
    const details: Record<string, unknown> = { bucket: 'backups', region: 'us-east-1' };
    canonicalizeS3CredentialFields(details);
    expect(details).toEqual({ bucket: 'backups', region: 'us-east-1' });
  });

  it('leaves an already-canonical config untouched', () => {
    const details: Record<string, unknown> = { accessKey: 'AK', secretKey: 'SK' };
    canonicalizeS3CredentialFields(details);
    expect(details).toEqual({ accessKey: 'AK', secretKey: 'SK' });
  });
});

// #5396: the job list must accept filtering on the new terminal status.
describe('jobListSchema status (#5396)', () => {
  it('accepts completed_with_errors', () => {
    expect(jobListSchema.safeParse({ status: 'completed_with_errors' }).success).toBe(true);
  });
});
