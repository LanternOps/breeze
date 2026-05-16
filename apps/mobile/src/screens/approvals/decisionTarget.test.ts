import { describe, expect, it } from 'vitest';

import { decisionTarget } from './decisionTarget';

type Approval = { id: string; status: string; riskTier: string };

const pendingA: Approval = { id: 'A', status: 'pending', riskTier: 'low' };
const pendingB: Approval = { id: 'B', status: 'pending', riskTier: 'high' };

describe('decisionTarget — binds biometric consent to the request the user saw', () => {
  it('returns the focused approval when the captured id still matches a pending request', () => {
    expect(decisionTarget('A', pendingA)).toBe(pendingA);
  });

  it('returns null when nothing is focused anymore', () => {
    expect(decisionTarget('A', undefined)).toBeNull();
  });

  it('returns null when focus swapped to a different request during the biometric prompt', () => {
    // User authenticated for A; a second push moved focus to B mid-prompt.
    // Must NOT silently approve B.
    expect(decisionTarget('A', pendingB)).toBeNull();
  });

  it('returns null when the captured request is no longer pending (decided/expired during the prompt)', () => {
    expect(decisionTarget('A', { id: 'A', status: 'expired', riskTier: 'low' })).toBeNull();
    expect(decisionTarget('A', { id: 'A', status: 'approved', riskTier: 'low' })).toBeNull();
  });
});
