// apps/api/src/services/aiAgents/narrativeProfile.test.ts
import { describe, expect, it } from 'vitest';
import {
  NARRATIVE_OUTCOME_TOOL_NAME,
  NARRATIVE_TOOL_ALLOWLIST,
  isNarrativeProfile,
  narrativeLimits,
  narrativeToolAllowlist,
} from './narrativeProfile';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { OUTCOME_TOOL_NAMES } from './outcomeTools';

describe('narrative profile', () => {
  // The load-bearing difference from `sweep`/`verdict`: a narrative run reads
  // NOTHING live. Its whole input is the system-collected weekly context
  // assembled before the run, so there is no drill-down floor at all — the
  // model may call exactly one tool, the outcome tool. Duplicated as a
  // contract in `verdictProfile.contract.test.ts`.
  it('the read-only drill-down floor is EMPTY — a narrative run reads no live data', () => {
    expect(NARRATIVE_TOOL_ALLOWLIST).toEqual([]);
  });

  it('pins turns/budget to the narrative limits and forbids act reservations', () => {
    const l = narrativeLimits({
      ...AI_AGENT_LIMIT_DEFAULTS,
      narrativeMaxTurns: 4,
      narrativeBudgetCentsPerRun: 33,
    });
    expect(l.maxTurnsPerRun).toBe(4);
    expect(l.maxBudgetCentsPerRun).toBe(33);
    expect(l.maxActionsPerRun).toBe(0);
  });

  // A policy snapshot resolved before the v7 limits bump carries no
  // narrativeMaxTurns/narrativeBudgetCentsPerRun at all — same tolerant-read
  // pattern as sweepLimits' pre-v6 fallback test. Without it the SDK's
  // `maxBudgetUsd` becomes NaN.
  it('falls back to AI_AGENT_LIMIT_DEFAULTS for a pre-v7 snapshot', () => {
    const { narrativeMaxTurns: _t, narrativeBudgetCentsPerRun: _b, ...preV7Limits } =
      AI_AGENT_LIMIT_DEFAULTS;
    const l = narrativeLimits(preV7Limits as typeof AI_AGENT_LIMIT_DEFAULTS);
    expect(l.maxTurnsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.narrativeMaxTurns);
    expect(l.maxBudgetCentsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.narrativeBudgetCentsPerRun);
    expect(l.maxBudgetCentsPerRun).not.toBeNaN();
    expect(l.maxTurnsPerRun).not.toBeNaN();
  });

  it('the allowlist is a floor that ignores the agent list and is the outcome tool alone', () => {
    expect(narrativeToolAllowlist(['manage_services', 'run_script']))
      .toEqual([NARRATIVE_OUTCOME_TOOL_NAME]);
    expect(narrativeToolAllowlist([])).toEqual(['submit_narrative']);
  });

  /**
   * Drift guard for the cross-task dependency documented on
   * `NARRATIVE_OUTCOME_TOOL_NAME`: task 6 of this same wave is what adds
   * `submit_narrative` to `OUTCOME_TOOL_NAMES` (the single source of truth for
   * outcome-tool names). Until it lands there is nothing to compare against;
   * the moment it does, this fails loudly if task 6 registered the name under
   * any other spelling, rather than leaving the floor exposing a stale literal
   * the pre-hook would then deny.
   */
  it('agrees with outcomeTools.ts once task 6 registers the narrative outcome tool', () => {
    const registered = (OUTCOME_TOOL_NAMES as readonly string[]).filter((n) => n.includes('narrative'));
    if (registered.length > 0) {
      expect(registered).toEqual([NARRATIVE_OUTCOME_TOOL_NAME]);
    }
  });

  it('isNarrativeProfile', () => {
    expect(isNarrativeProfile({ profile: 'narrative' })).toBe(true);
    expect(isNarrativeProfile({ profile: 'full' })).toBe(false);
    expect(isNarrativeProfile({ profile: 'sweep' })).toBe(false);
    expect(isNarrativeProfile({ profile: 'verdict' })).toBe(false);
  });
});
