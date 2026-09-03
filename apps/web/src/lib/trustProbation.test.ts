import { describe, expect, it, vi } from 'vitest';
import {
  dispatchTrustDenied,
  isTrustDenial,
  TRUST_DENIED_EVENT,
} from './trustProbation';

const denial = {
  error: 'TRUST_PROBATION' as const,
  capability: 'device_execute' as const,
  reason: 'probation_default_deny',
  reviewRequested: false,
  meetingUrl: null,
};

describe('trustProbation', () => {
  it('recognises only complete trust-denial response bodies', () => {
    expect(isTrustDenial(denial)).toBe(true);
    expect(isTrustDenial({ ...denial, error: 'FORBIDDEN' })).toBe(false);
    expect(isTrustDenial({ ...denial, capability: 'billing' })).toBe(false);
    expect(isTrustDenial({ ...denial, reviewRequested: 'false' })).toBe(false);
    expect(isTrustDenial(null)).toBe(false);
  });

  it('dispatches the shared event with the denial as detail', () => {
    const listener = vi.fn();
    window.addEventListener(TRUST_DENIED_EVENT, listener);
    dispatchTrustDenied(denial);
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toBe(denial);
    window.removeEventListener(TRUST_DENIED_EVENT, listener);
  });

  it('returns true when a listener calls preventDefault (handled)', () => {
    const listener = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener(TRUST_DENIED_EVENT, listener);
    expect(dispatchTrustDenied(denial)).toBe(true);
    window.removeEventListener(TRUST_DENIED_EVENT, listener);
  });

  it('returns false when no listener claims the event', () => {
    expect(dispatchTrustDenied(denial)).toBe(false);
  });

  it('returns false when a listener observes but does not call preventDefault', () => {
    const listener = vi.fn();
    window.addEventListener(TRUST_DENIED_EVENT, listener);
    expect(dispatchTrustDenied(denial)).toBe(false);
    window.removeEventListener(TRUST_DENIED_EVENT, listener);
  });
});
