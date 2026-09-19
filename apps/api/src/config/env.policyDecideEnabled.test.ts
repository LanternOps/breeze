import { afterEach, describe, expect, it } from 'vitest';
import { policyDecideEnabled } from './env';

// Wave 5 Part B (#3827). Sub-flag of BREEZE_AI_AGENTS_ENABLED gating
// attemptPolicyDecision — see the Global Constraints dark-ship statement in
// the plan header. Read at CALL time (not a module-scope const) so a test can
// flip it per-case without vi.resetModules(), same as isHosted()/breezeRole().
describe('policyDecideEnabled()', () => {
  const original = process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED;
    else process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = original;
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['garbage', false],
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    ['  true  ', true],
  ])('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED=%s → %s', (raw, expected) => {
    if (raw === undefined) delete process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED;
    else process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = raw;
    expect(policyDecideEnabled()).toBe(expected);
  });

  it('is read at call time — flipping the env var changes the very next call, no reimport needed', () => {
    delete process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED;
    expect(policyDecideEnabled()).toBe(false);
    process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = 'true';
    expect(policyDecideEnabled()).toBe(true);
    process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = 'false';
    expect(policyDecideEnabled()).toBe(false);
  });
});
