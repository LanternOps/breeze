import { describe, expect, it } from 'vitest';
import {
  securitySweepScopeSchema,
  securitySweepRequestSchema,
  securitySweepCreateSchema,
  securityScanPathSchema,
} from './securityScanSweep';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => id(i + 1 + offset));

const base = { ruleSetIds: [id(9001)], scope: { kind: 'all' as const }, scanType: 'quick' as const };

describe('securitySweepScopeSchema', () => {
  it('accepts each scope kind', () => {
    expect(securitySweepScopeSchema.safeParse({ kind: 'all' }).success).toBe(true);
    expect(securitySweepScopeSchema.safeParse({ kind: 'orgs', orgIds: ids(2) }).success).toBe(true);
    expect(securitySweepScopeSchema.safeParse({ kind: 'sites', siteIds: ids(3) }).success).toBe(true);
    expect(securitySweepScopeSchema.safeParse({ kind: 'groups', groupIds: ids(1) }).success).toBe(true);
    expect(securitySweepScopeSchema.safeParse({ kind: 'devices', deviceIds: ids(5) }).success).toBe(true);
    expect(securitySweepScopeSchema.safeParse({ kind: 'nope' }).success).toBe(false);
  });

  it('rejects an empty id list and a non-uuid id', () => {
    expect(securitySweepScopeSchema.safeParse({ kind: 'orgs', orgIds: [] }).success).toBe(false);
    expect(securitySweepScopeSchema.safeParse({ kind: 'devices', deviceIds: ['not-a-uuid'] }).success).toBe(false);
  });

  it('rejects unknown keys on a scope', () => {
    expect(securitySweepScopeSchema.safeParse({ kind: 'all', orgIds: ids(1) }).success).toBe(false);
  });
});

describe('securitySweepRequestSchema', () => {
  it('bounds arrays', () => {
    const scope = (s: unknown) => securitySweepRequestSchema.safeParse({ ...base, scope: s }).success;
    expect(scope({ kind: 'orgs', orgIds: ids(100) })).toBe(true);
    expect(scope({ kind: 'orgs', orgIds: ids(101) })).toBe(false);
    expect(scope({ kind: 'sites', siteIds: ids(200) })).toBe(true);
    expect(scope({ kind: 'sites', siteIds: ids(201) })).toBe(false);
    expect(scope({ kind: 'groups', groupIds: ids(50) })).toBe(true);
    expect(scope({ kind: 'groups', groupIds: ids(51) })).toBe(false);
    expect(scope({ kind: 'devices', deviceIds: ids(1000) })).toBe(true);
    expect(scope({ kind: 'devices', deviceIds: ids(1001) })).toBe(false);

    expect(securitySweepRequestSchema.safeParse({ ...base, ruleSetIds: ids(20) }).success).toBe(true);
    expect(securitySweepRequestSchema.safeParse({ ...base, ruleSetIds: ids(21) }).success).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, ruleSetIds: [] }).success).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, ruleSetIds: [id(1), id(1)] }).success).toBe(false);
  });

  it('paths only for custom', () => {
    expect(securitySweepRequestSchema.safeParse({ ...base, scanType: 'quick', paths: ['/tmp'] }).success).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, scanType: 'custom' }).success).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, scanType: 'custom', paths: [] }).success).toBe(false);
    expect(
      securitySweepRequestSchema.safeParse({ ...base, scanType: 'custom', paths: Array.from({ length: 21 }, (_, i) => `/p${i}`) })
        .success,
    ).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, scanType: 'custom', paths: ['/' + 'a'.repeat(1024)] }).success).toBe(
      false,
    );
    expect(securitySweepRequestSchema.safeParse({ ...base, scanType: 'custom', paths: ['/' + 'a'.repeat(1023)] }).success).toBe(
      true,
    );
    expect(securitySweepRequestSchema.safeParse({ ...base, scanType: 'custom', paths: ['C:\\Users', '/tmp'] }).success).toBe(true);
    expect(securitySweepRequestSchema.safeParse({ ...base, scanType: 'full' }).success).toBe(true);
  });

  it('ttlHours', () => {
    expect(securitySweepRequestSchema.safeParse({ ...base, ttlHours: 0 }).success).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, ttlHours: 73 }).success).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, ttlHours: 1.5 }).success).toBe(false);
    expect(securitySweepRequestSchema.safeParse({ ...base, ttlHours: 1 }).success).toBe(true);
    expect(securitySweepRequestSchema.safeParse({ ...base, ttlHours: 72 }).success).toBe(true);
    expect(securitySweepRequestSchema.safeParse(base).success).toBe(true);
  });

  it('rejects unknown keys (no smuggled previewDigest on preview, no autoQuarantine)', () => {
    expect(securitySweepRequestSchema.safeParse({ ...base, autoQuarantine: true }).success).toBe(false);
  });
});

describe('securitySweepCreateSchema', () => {
  it('create requires a 64-hex previewDigest', () => {
    const digest = 'a'.repeat(64);
    expect(securitySweepCreateSchema.safeParse({ ...base, previewDigest: digest }).success).toBe(true);
    expect(securitySweepCreateSchema.safeParse(base).success).toBe(false);
    expect(securitySweepCreateSchema.safeParse({ ...base, previewDigest: 'A'.repeat(64) }).success).toBe(false);
    expect(securitySweepCreateSchema.safeParse({ ...base, previewDigest: 'a'.repeat(63) }).success).toBe(false);
    expect(securitySweepCreateSchema.safeParse({ ...base, previewDigest: 'g'.repeat(64) }).success).toBe(false);
  });

  it('keeps the paths ⇔ custom rule', () => {
    const digest = 'b'.repeat(64);
    expect(securitySweepCreateSchema.safeParse({ ...base, scanType: 'custom', previewDigest: digest }).success).toBe(false);
  });
});

describe('securityScanPathSchema', () => {
  it('is the single path element: non-empty, at most 1024 characters', () => {
    expect(securityScanPathSchema.safeParse('').success).toBe(false);
    expect(securityScanPathSchema.safeParse('a'.repeat(1024)).success).toBe(true);
    expect(securityScanPathSchema.safeParse('a'.repeat(1025)).success).toBe(false);
  });
});
