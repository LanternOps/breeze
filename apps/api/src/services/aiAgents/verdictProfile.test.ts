// apps/api/src/services/aiAgents/verdictProfile.test.ts
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { VERDICT_TOOL_ALLOWLIST, verdictLimits, verdictToolAllowlist } from './verdictProfile';
import { TIER2_ACTIONS, TIER2_READONLY_TOOLS, TIER3_ACTIONS } from '../aiGuardrails';
import { TOOL_TIERS } from '../aiAgentSdkTools';

describe('verdict profile', () => {
  it('pins turns to 4 and budget to verdictBudgetCentsPerRun', () => {
    const l = verdictLimits({ ...AI_AGENT_LIMIT_DEFAULTS, verdictBudgetCentsPerRun: 5 });
    expect(l.maxTurnsPerRun).toBe(4);
    expect(l.maxBudgetCentsPerRun).toBe(5);
    expect(l.maxActionsPerRun).toBe(0);
  });
  // Review fix (fix round 1): a v1-v4 policy snapshot has no
  // `verdictBudgetCentsPerRun` field at all (predates the wave-6 bump) — an
  // in-flight run on one must still get a real (non-NaN) budget ceiling.
  it('falls back to AI_AGENT_LIMIT_DEFAULTS.verdictBudgetCentsPerRun for a pre-P2-1 (v1-v4) snapshot', () => {
    const { verdictBudgetCentsPerRun: _omitted, ...preP21Limits } = AI_AGENT_LIMIT_DEFAULTS;
    const l = verdictLimits(preP21Limits as typeof AI_AGENT_LIMIT_DEFAULTS);
    expect(l.maxBudgetCentsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.verdictBudgetCentsPerRun);
    expect(l.maxBudgetCentsPerRun).not.toBeNaN();
  });
  // Review fix (fix round 1, PLAN CHANGE — supersedes the original
  // "intersects, never widens" design): the agent's OWN `full`-profile
  // allowlist must never narrow (or, via a bare multi-action tool name like
  // `manage_alerts`, effectively widen) a verdict run's exposure — the floor
  // is served regardless.
  it('always returns the pinned floor + outcome tool, ignoring the agent allowlist entirely', () => {
    expect(verdictToolAllowlist(['manage_alerts:list', 'run_script'])).toEqual([...VERDICT_TOOL_ALLOWLIST, 'submit_alert_verdict']);
    expect(verdictToolAllowlist([])).toEqual([...VERDICT_TOOL_ALLOWLIST, 'submit_alert_verdict']);
    // A broad agent allowlist (bare `manage_alerts`, which on a FULL run also
    // grants acknowledge/resolve/suppress) must not change the result either
    // — this is the exact shape of the bug the plan change closes.
    expect(verdictToolAllowlist(['manage_alerts', 'run_script', 'manage_services'])).toEqual([...VERDICT_TOOL_ALLOWLIST, 'submit_alert_verdict']);
  });
  it('every allowlisted tool/action is read-only', () => {
    for (const entry of VERDICT_TOOL_ALLOWLIST) {
      // `noUncheckedIndexedAccess` widens array-destructure results to
      // `T | undefined`; `entry` always has a tool segment before an
      // optional `:action` one, by construction of VERDICT_TOOL_ALLOWLIST.
      const [tool, action] = entry.split(':') as [string, string | undefined];
      if (action) {
        expect(TIER2_ACTIONS[tool] ?? []).not.toContain(action);
        // Review round 2 (Minor 5): a `tool:action` entry must not name an
        // action TIER3_ACTIONS escalates to approval-required — this floor
        // is meant to be auto-execute read-only, never a Tier-3 mutation
        // that slipped past the TIER2_ACTIONS check above.
        expect(TIER3_ACTIONS[tool] ?? []).not.toContain(action);
      } else {
        expect(TOOL_TIERS[tool as keyof typeof TOOL_TIERS] === 1 || TIER2_READONLY_TOOLS.has(tool)).toBe(true);
      }
    }
  });
});
