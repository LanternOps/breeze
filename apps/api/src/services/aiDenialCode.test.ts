import { describe, it, expect } from 'vitest';
import { aiDenialBody, aiDenialClientCode } from './aiDenialCode';

describe('aiDenialClientCode', () => {
  it('maps the prepaid-credit gate to credits_exhausted', () => {
    expect(aiDenialClientCode('credits_exhausted')).toBe('credits_exhausted');
  });
  it('maps the plan gate to plan_not_eligible', () => {
    expect(aiDenialClientCode('plan_gate')).toBe('plan_not_eligible');
  });
  it.each(['daily_budget', 'monthly_budget', 'ai_disabled'] as const)('leaves %s uncoded', (reason) => {
    expect(aiDenialClientCode(reason)).toBeUndefined();
  });
});

describe('aiDenialBody', () => {
  it('carries error + code for a coded denial', () => {
    expect(aiDenialBody({ message: 'out', reason: 'credits_exhausted' })).toEqual({ error: 'out', code: 'credits_exhausted' });
  });
  it('omits code for an uncoded denial', () => {
    expect(aiDenialBody({ message: 'cap', reason: 'daily_budget' })).toEqual({ error: 'cap' });
  });
});
