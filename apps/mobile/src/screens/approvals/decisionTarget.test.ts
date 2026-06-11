import { describe, expect, it } from 'vitest';

import { captureRequestId, decisionTarget } from './decisionTarget';
import type { ApprovalStatus } from '../../services/approvals';

type Approval = { id: string; status: ApprovalStatus; riskTier: string };

const pendingA: Approval = { id: 'A', status: 'pending', riskTier: 'low' };
const pendingB: Approval = { id: 'B', status: 'pending', riskTier: 'high' };

describe('decisionTarget — binds biometric consent to the request the user saw', () => {
  it('returns the focused approval when the captured id still matches a pending request', () => {
    expect(decisionTarget(captureRequestId('A'), pendingA)).toBe(pendingA);
  });

  it('returns null when nothing is focused anymore', () => {
    expect(decisionTarget(captureRequestId('A'), undefined)).toBeNull();
  });

  it('returns null when focus swapped to a different request during the biometric prompt', () => {
    // User authenticated for A; a second push moved focus to B mid-prompt.
    // Must NOT silently approve B.
    expect(decisionTarget(captureRequestId('A'), pendingB)).toBeNull();
  });

  it('returns null when the captured request is no longer pending (decided/expired during the prompt)', () => {
    // Covers every non-pending ApprovalStatus the request could have raced
    // into while the biometric modal was up.
    expect(decisionTarget(captureRequestId('A'), { id: 'A', status: 'expired', riskTier: 'low' })).toBeNull();
    expect(decisionTarget(captureRequestId('A'), { id: 'A', status: 'approved', riskTier: 'low' })).toBeNull();
    expect(decisionTarget(captureRequestId('A'), { id: 'A', status: 'denied', riskTier: 'low' })).toBeNull();
    expect(decisionTarget(captureRequestId('A'), { id: 'A', status: 'reported', riskTier: 'low' })).toBeNull();
  });
});
