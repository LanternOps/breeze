import { describe, it, expect } from 'vitest';
import { auditRetentionPolicySchema } from './auditRetention';

describe('auditRetentionPolicySchema', () => {
  it('accepts a valid retentionDays', () => {
    const result = auditRetentionPolicySchema.safeParse({ retentionDays: 90 });
    expect(result.success).toBe(true);
  });

  it('rejects a missing retentionDays', () => {
    expect(auditRetentionPolicySchema.safeParse({}).success).toBe(false);
  });

  it('rejects zero (would prune everything on the next run)', () => {
    expect(auditRetentionPolicySchema.safeParse({ retentionDays: 0 }).success).toBe(false);
  });

  it('rejects negative values', () => {
    expect(auditRetentionPolicySchema.safeParse({ retentionDays: -1 }).success).toBe(false);
  });

  it('rejects non-integer values', () => {
    expect(auditRetentionPolicySchema.safeParse({ retentionDays: 1.5 }).success).toBe(false);
  });

  it('accepts the 10-year cap', () => {
    expect(auditRetentionPolicySchema.safeParse({ retentionDays: 3650 }).success).toBe(true);
  });

  it('rejects beyond the 10-year cap', () => {
    expect(auditRetentionPolicySchema.safeParse({ retentionDays: 3651 }).success).toBe(false);
  });
});
