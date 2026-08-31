// apps/api/src/services/aiAgents/sweepProfile.test.ts
import { describe, expect, it } from 'vitest';
import { SWEEP_TOOL_ALLOWLIST, sweepLimits, sweepToolAllowlist, isSweepProfile } from './sweepProfile';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { TIER2_READONLY_TOOLS } from '../aiGuardrails';

describe('sweep profile', () => {
  it('every floor tool is read-only (tier 1, or tier 2 read-only)', () => {
    for (const name of SWEEP_TOOL_ALLOWLIST) {
      const tier = TOOL_TIERS[name as keyof typeof TOOL_TIERS];
      expect(tier === 1 || (tier === 2 && TIER2_READONLY_TOOLS.has(name)), name).toBe(true);
    }
  });
  it('pins turns/budget to the sweep limits and forbids act reservations', () => {
    const l = sweepLimits({ ...AI_AGENT_LIMIT_DEFAULTS, sweepMaxTurns: 6, sweepBudgetCentsPerRun: 12 });
    expect(l.maxTurnsPerRun).toBe(6); expect(l.maxBudgetCentsPerRun).toBe(12); expect(l.maxActionsPerRun).toBe(0);
  });
  // Review fix: a policy snapshot resolved before the v6 limits bump carries
  // no sweepMaxTurns/sweepBudgetCentsPerRun at all — mirrors verdictLimits'
  // pre-P2-1 fallback test.
  it('falls back to AI_AGENT_LIMIT_DEFAULTS for a pre-v6 snapshot', () => {
    const { sweepMaxTurns: _t, sweepBudgetCentsPerRun: _b, ...preV6Limits } = AI_AGENT_LIMIT_DEFAULTS;
    const l = sweepLimits(preV6Limits as typeof AI_AGENT_LIMIT_DEFAULTS);
    expect(l.maxTurnsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.sweepMaxTurns);
    expect(l.maxBudgetCentsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.sweepBudgetCentsPerRun);
    expect(l.maxBudgetCentsPerRun).not.toBeNaN();
  });
  it('the allowlist is a floor that ignores the agent list and includes only the sweep outcome tool', () => {
    expect(sweepToolAllowlist(['manage_services'])).toEqual([...SWEEP_TOOL_ALLOWLIST, 'submit_sweep_findings']);
  });
  it('isSweepProfile', () => { expect(isSweepProfile({ profile: 'sweep' })).toBe(true); expect(isSweepProfile({ profile: 'full' })).toBe(false); });
});
