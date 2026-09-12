import { describe, expect, it } from 'vitest';
import { checkGuardrails, resolveApprovalScope } from './aiGuardrails';

const devices = ['11111111-1111-4111-8111-111111111111'];
const ctx = (riskTier: 'low' | 'medium' | 'high' | 'critical', strictHits: string[] = []) =>
  ({ proposal: { riskTier, strictHits } });

describe('run_script with a proposalId', () => {
  it('stays tier 3 and maps low/medium to supervised', () => {
    for (const tier of ['low', 'medium'] as const) {
      const check = checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices }, ctx(tier));
      expect(check.tier).toBe(3);
      expect(check.allowed).toBe(true);
      expect(check.approvalScope).toBe('supervised');
    }
  });

  it('maps high/critical to four_eyes', () => {
    for (const tier of ['high', 'critical'] as const) {
      expect(checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices }, ctx(tier)).approvalScope)
        .toBe('four_eyes');
    }
  });

  it('denies at tier 4 with proposal_context_missing when no context is supplied', () => {
    const check = checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices });
    expect(check.tier).toBe(4);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('proposal_context_missing');
  });

  it('denies when a context is supplied for a different shape (no proposal key)', () => {
    const check = checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices }, {});
    expect(check.tier).toBe(4);
    expect(check.allowed).toBe(false);
  });

  it('leaves an ordinary library run_script untouched — supervised, context ignored', () => {
    const check = checkGuardrails('run_script', { scriptId: 's1', deviceIds: devices });
    expect(check.tier).toBe(3);
    expect(check.approvalScope).toBe('supervised');
  });

  it('leaves every other tool untouched when a context is passed', () => {
    expect(checkGuardrails('query_devices', {}, ctx('critical')).tier).toBe(1);
  });

  it('resolveApprovalScope agrees with checkGuardrails for both directions', () => {
    expect(resolveApprovalScope('run_script', undefined, { proposalId: 'p1' }, ctx('low'))).toBe('supervised');
    expect(resolveApprovalScope('run_script', undefined, { proposalId: 'p1' }, ctx('high'))).toBe('four_eyes');
    // Fail-safe: no context on a proposal call resolves four_eyes, matching the
    // module's own "unclassified defaults to four_eyes" rule.
    expect(resolveApprovalScope('run_script', undefined, { proposalId: 'p1' })).toBe('four_eyes');
  });
});
