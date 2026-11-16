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

  it('denies with proposal_not_found when the loaded context says so', () => {
    const check = checkGuardrails(
      'run_script', { proposalId: 'p1', deviceIds: devices }, { proposalDenyReason: 'proposal_not_found' },
    );
    expect(check.tier).toBe(4);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('proposal_not_found');
    expect(check.reason).not.toContain('proposal_context_missing');
  });

  it('denies with proposal_review_pending and a poll hint when the review has not completed', () => {
    const check = checkGuardrails(
      'run_script', { proposalId: 'p1', deviceIds: devices }, { proposalDenyReason: 'proposal_review_pending' },
    );
    expect(check.tier).toBe(4);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('proposal_review_pending');
    expect(check.reason).toContain('get_script_proposal');
  });

  it('denies with proposal_review_failed when the review ended negatively', () => {
    const check = checkGuardrails(
      'run_script', { proposalId: 'p1', deviceIds: devices }, { proposalDenyReason: 'proposal_review_failed' },
    );
    expect(check.tier).toBe(4);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('proposal_review_failed');
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

// #11979: a proposal-backed run_script has no scriptId, so the headline read
// "Run script unknown... on 1 device(s)" — naming neither the script nor the device.
describe('run_script approval headline', () => {
  const proposalId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const scriptId = 'cccccccc-1111-4111-8111-111111111111';
  const withGoal = (goal: string) => ({ proposal: { riskTier: 'low' as const, strictHits: [], goal } });

  it('names a proposal-backed run by the proposal goal, never "unknown"', () => {
    const check = checkGuardrails(
      'run_script', { proposalId, deviceIds: [devices[0], 'bbbbbbbb-1111-4111-8111-111111111111'] },
      withGoal('Clear the print spooler queue'),
    );
    expect(check.description).toBe('Run proposed script "Clear the print spooler queue" on 2 device(s)');
  });

  it('names the one device by its id stub, which the approval surfaces swap for its name', () => {
    const check = checkGuardrails('run_script', { proposalId, deviceIds: devices }, withGoal('Clear the spooler'));
    expect(check.description).toBe('Run proposed script "Clear the spooler" on device 11111111...');
  });

  it('keeps a model-written goal to one bounded line', () => {
    const check = checkGuardrails(
      'run_script', { proposalId, deviceIds: devices }, withGoal(`Fix\n\tthe ${'x'.repeat(200)}`),
    );
    expect(check.description).toMatch(/^Run proposed script "Fix the x{72}…" on device 11111111\.\.\.$/);
  });

  it('falls back to the proposal id stub when the context carries no goal', () => {
    const check = checkGuardrails('run_script', { proposalId, deviceIds: devices }, ctx('low'));
    expect(check.description).toBe('Run proposed script aaaaaaaa... on device 11111111...');
  });

  it('keeps the library-script headline, naming a single device by its stub', () => {
    expect(checkGuardrails('run_script', { scriptId, deviceIds: devices }).description)
      .toBe('Run script cccccccc... on device 11111111...');
    expect(checkGuardrails('run_script', { scriptId, deviceIds: [devices[0], proposalId] }).description)
      .toBe('Run script cccccccc... on 2 device(s)');
  });
});
