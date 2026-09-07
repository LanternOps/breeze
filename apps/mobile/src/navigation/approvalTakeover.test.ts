import { describe, it, expect } from 'vitest';

import { selectFocusedApproval, selectTakeoverVisible, type ApprovalTakeoverQueueState } from './approvalTakeover';
import type { ApprovalRequest } from '../services/approvals';

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1',
    requestingClientLabel: 'Claude Web',
    requestingMachineLabel: null,
    actionLabel: 'Restart agent on box-1',
    actionToolName: 'restart_agent',
    actionArguments: {},
    riskTier: 'medium',
    riskSummary: 'Will reboot the agent service',
    customerTenant: null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    decidedAt: null,
    decisionReason: null,
    isRecursive: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * #5172: ApprovalGate (Modal.visible) and ApprovalScreen (its content
 * branch) used to each recompute "is there a focused pending approval"
 * with their own independently-written inline selector. This module is the
 * single shared derivation both must call instead, so there is no way for
 * one to say visible while the other says hidden.
 */
describe('selectFocusedApproval / selectTakeoverVisible', () => {
  it('pending with one row → visible+focused', () => {
    const row = makeApproval({ id: 'a' });
    const state: ApprovalTakeoverQueueState = { pending: [row], focusId: 'a' };

    expect(selectFocusedApproval(state)).toBe(row);
    expect(selectTakeoverVisible(state)).toBe(true);
  });

  it('after dropAndRefocus → both hidden in the same state', () => {
    // Simulates the reducer transition approve.fulfilled/deny.fulfilled run:
    // the decided row is filtered out of `pending` and, since nothing else
    // is left pending, `focusId` rolls to null in the SAME state update.
    const state: ApprovalTakeoverQueueState = { pending: [], focusId: null };

    expect(selectFocusedApproval(state)).toBeUndefined();
    expect(selectTakeoverVisible(state)).toBe(false);
  });

  it('rolls to the next pending row when one is dropped but another remains', () => {
    const next = makeApproval({ id: 'b' });
    const state: ApprovalTakeoverQueueState = { pending: [next], focusId: 'b' };

    expect(selectFocusedApproval(state)).toBe(next);
    expect(selectTakeoverVisible(state)).toBe(true);
  });

  it('ignores a focusId that points at a non-pending (e.g. expired) row', () => {
    const row = makeApproval({ id: 'a', status: 'expired' });
    const state: ApprovalTakeoverQueueState = { pending: [row], focusId: 'a' };

    expect(selectFocusedApproval(state)).toBeUndefined();
    expect(selectTakeoverVisible(state)).toBe(false);
  });
});
