import { describe, expect, it } from 'vitest';
import { getOrgMergePolicies } from './orgMergeRegistry';
import {
  CUSTOM_EXECUTORS, CUSTOM_RESOLVE_EXECUTORS, CUSTOM_WOULD_REVOKE_COUNTS,
} from './orgMergeCustomExecutors';

describe('script proposal org-merge disposition', () => {
  it('classifies proposals as custom so the fence can run, and reviews as leave-for-erasure', () => {
    const policies = getOrgMergePolicies();
    expect(policies.get('script_proposals')).toEqual(expect.objectContaining({ kind: 'custom' }));
    expect(policies.get('script_proposal_reviews'))
      .toEqual(expect.objectContaining({ kind: 'leave-for-erasure' }));
  });

  it('declares a resolve-phase fence AND a move half — a resolve half alone strands rows', () => {
    expect(CUSTOM_RESOLVE_EXECUTORS.script_proposals).toBeTypeOf('function');
    expect(CUSTOM_EXECUTORS.script_proposals).toBeTypeOf('function');
  });

  it('mirrors the fence in the merge preview so an operator is told work will stop', () => {
    expect(CUSTOM_WOULD_REVOKE_COUNTS.script_proposals).toBeTypeOf('function');
  });
});
