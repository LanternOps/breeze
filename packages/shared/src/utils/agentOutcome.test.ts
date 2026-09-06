import { describe, it, expect } from 'vitest';
import { outcomeFor } from './agentOutcome';

describe('outcomeFor', () => {
  it('act mode: an act-eligible operation is unattended', () => {
    expect(outcomeFor({ tier: 3, actEligible: true }, 'act')).toBe('unattended');
    expect(outcomeFor({ tier: 1, actEligible: true }, 'act')).toBe('unattended');
  });

  it('act mode: a non-act-eligible tier-3 operation still falls back to approval_request', () => {
    expect(outcomeFor({ tier: 3, actEligible: false }, 'act')).toBe('approval_request');
  });

  it('act mode: a non-act-eligible tier 1/2 operation falls back to logged_proposal', () => {
    expect(outcomeFor({ tier: 1, actEligible: false }, 'act')).toBe('logged_proposal');
    expect(outcomeFor({ tier: 2, actEligible: false }, 'act')).toBe('logged_proposal');
  });

  it('shadow/off mode splits by tier alone, never unattended even when act-eligible', () => {
    expect(outcomeFor({ tier: 3, actEligible: true }, 'shadow')).toBe('approval_request');
    expect(outcomeFor({ tier: 2, actEligible: true }, 'shadow')).toBe('logged_proposal');
    expect(outcomeFor({ tier: 1, actEligible: true }, 'off')).toBe('logged_proposal');
    expect(outcomeFor({ tier: 3, actEligible: true }, 'off')).toBe('approval_request');
  });
});
