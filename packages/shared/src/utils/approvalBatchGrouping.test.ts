import { describe, it, expect } from 'vitest';

import {
  APPROVAL_BATCH_GROUP_SEPARATOR,
  approvalBatchGroupKey,
  approvalBatchGroupParts,
  normalizeApprovalBatchAction,
} from './approvalBatchGrouping';

const base = {
  orgId: 'org-1',
  actionToolName: 'manage_services',
  action: 'restart' as unknown,
};

describe('normalizeApprovalBatchAction', () => {
  it('trims and lower-cases a string action', () => {
    expect(normalizeApprovalBatchAction('  ReStart  ')).toBe('restart');
  });

  it('returns null for anything that is not a string', () => {
    for (const value of [null, undefined, 42, true, {}, ['restart']]) {
      expect(normalizeApprovalBatchAction(value)).toBeNull();
    }
  });

  it('returns an empty string (not null) for a whitespace-only action', () => {
    expect(normalizeApprovalBatchAction('   ')).toBe('');
  });
});

describe('approvalBatchGroupKey', () => {
  it('is the NUL-joined (orgId, tool, normalized action) triple', () => {
    expect(APPROVAL_BATCH_GROUP_SEPARATOR).toBe('\u0000');
    expect(approvalBatchGroupKey(base)).toBe(
      ['org-1', 'manage_services', 'restart'].join('\u0000'),
    );
  });

  it('ignores cosmetic differences in how the action was spelled', () => {
    expect(approvalBatchGroupKey({ ...base, action: ' RESTART ' })).toBe(
      approvalBatchGroupKey(base),
    );
  });

  it('separates a different action into a different group', () => {
    expect(approvalBatchGroupKey({ ...base, action: 'stop' })).not.toBe(
      approvalBatchGroupKey(base),
    );
  });

  it('separates a different org into a different group', () => {
    expect(approvalBatchGroupKey({ ...base, orgId: 'org-2' })).not.toBe(
      approvalBatchGroupKey(base),
    );
  });

  it('separates a different tool into a different group', () => {
    expect(approvalBatchGroupKey({ ...base, actionToolName: 'manage_patches' })).not.toBe(
      approvalBatchGroupKey(base),
    );
  });

  it('treats a null org and a null action as their own empty-valued group', () => {
    expect(approvalBatchGroupKey({ orgId: null, actionToolName: 'run_script', action: null })).toBe(
      ['', 'run_script', ''].join('\u0000'),
    );
  });

  it('groups a non-string action with a missing one — both are "not multiplexed"', () => {
    expect(approvalBatchGroupKey({ ...base, action: { nested: 'restart' } })).toBe(
      approvalBatchGroupKey({ ...base, action: null }),
    );
  });

  it('cannot be forged across field boundaries by concatenating two fields', () => {
    // With a plain separator a value could reach, ('a', 'b<sep>c', '') and
    // ('a', 'b', 'c') would collide. NUL is not representable in a tool name
    // or in a Postgres text value, so the two stay distinct.
    expect(approvalBatchGroupKey({ orgId: 'a', actionToolName: 'b', action: 'c' })).not.toBe(
      approvalBatchGroupKey({ orgId: 'a', actionToolName: 'b', action: null }),
    );
  });
});

describe('approvalBatchGroupParts', () => {
  it('exposes the same three parts the key is built from', () => {
    expect(approvalBatchGroupParts(base)).toEqual(['org-1', 'manage_services', 'restart']);
  });

  it('substitutes empty strings for a null org and a non-string action', () => {
    expect(
      approvalBatchGroupParts({ orgId: null, actionToolName: 'run_script', action: 7 }),
    ).toEqual(['', 'run_script', '']);
  });
});
