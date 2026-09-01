import { describe, expect, it } from 'vitest';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_POLICY_SNAPSHOT_VERSION,
  AI_AGENT_RUN_PROFILES,
  type AiAgentPolicySnapshot,
  type AlertVerdictOutcome,
  type AlertVerdictSuggestedAction,
} from './aiAgents';

describe('AI_AGENT_POLICY_SNAPSHOT_VERSION (v8, phase 2 P2-4)', () => {
  it('is the literal 8', () => {
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(8);
  });

  it('AiAgentPolicySnapshot.schemaVersion type-accepts every historical version 1-8', () => {
    // Type-level assertion: this only compiles if `schemaVersion` is widened
    // to `1 | 2 | 3 | 4 | 5 | 6 | 7 | 8`. If a future bump forgets to widen
    // the union, `tsc` fails this assignment, not a runtime check.
    const versions: Array<AiAgentPolicySnapshot['schemaVersion']> = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('AI_AGENT_LIMIT_DEFAULTS (sweep-profile limits, phase 2 P2-2)', () => {
  it('has the four sweep-profile fields', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentSweepRuns).toBe(2);
    expect(AI_AGENT_LIMIT_DEFAULTS.maxSweepRunsPerHour).toBe(20);
    expect(AI_AGENT_LIMIT_DEFAULTS.sweepBudgetCentsPerRun).toBe(30);
    expect(AI_AGENT_LIMIT_DEFAULTS.sweepMaxTurns).toBe(8);
  });
});

describe('AI_AGENT_LIMIT_DEFAULTS (narrative-profile limits, phase 2 P2-3)', () => {
  it('has the four narrative-profile fields', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentNarrativeRuns).toBe(1);
    expect(AI_AGENT_LIMIT_DEFAULTS.maxNarrativeRunsPerHour).toBe(5);
    expect(AI_AGENT_LIMIT_DEFAULTS.narrativeBudgetCentsPerRun).toBe(20);
    expect(AI_AGENT_LIMIT_DEFAULTS.narrativeMaxTurns).toBe(3);
  });
});

describe('AI_AGENT_LIMIT_DEFAULTS (triage-profile limits, phase 2 P2-4)', () => {
  it('has the four triage-profile fields', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentTriageRuns).toBe(2);
    expect(AI_AGENT_LIMIT_DEFAULTS.maxTriageRunsPerHour).toBe(30);
    expect(AI_AGENT_LIMIT_DEFAULTS.triageBudgetCentsPerRun).toBe(10);
    expect(AI_AGENT_LIMIT_DEFAULTS.triageMaxTurns).toBe(6);
  });
});

describe('AI_AGENT_RUN_PROFILES (triage profile, phase 2 P2-4)', () => {
  it('equals full, verdict, sweep, narrative, triage', () => {
    expect(AI_AGENT_RUN_PROFILES).toEqual(['full', 'verdict', 'sweep', 'narrative', 'triage']);
  });
});

/**
 * Compile-time exhaustiveness check on `AlertVerdictSuggestedAction`, mirroring
 * the pattern `aiAgentRuns.test.ts` uses for `AiAgentRunTraceEntryDto`. If a
 * third variant is ever added without a matching branch here, `action`
 * narrows to something other than `never` and `tsc` fails the assignment.
 */
function assertSuggestedActionExhaustive(action: AlertVerdictSuggestedAction): string {
  switch (action.action) {
    case 'suppress':
      return action.alertId;
    case 'resolve':
      return action.alertId;
    default: {
      const neverAction: never = action;
      throw new Error(`unreachable: ${JSON.stringify(neverAction)}`);
    }
  }
}

describe('AlertVerdictSuggestedAction (discriminated union, phase 2 P2-1)', () => {
  it('exhausts both variants at compile time', () => {
    const suppress: AlertVerdictSuggestedAction = {
      tool: 'manage_alerts', action: 'suppress', alertId: 'a1', suppressDuration: 24,
    };
    const resolve: AlertVerdictSuggestedAction = { tool: 'manage_alerts', action: 'resolve', alertId: 'a1' };
    expect(assertSuggestedActionExhaustive(suppress)).toBe('a1');
    expect(assertSuggestedActionExhaustive(resolve)).toBe('a1');
  });
});

describe('AlertVerdictOutcome (phase 2 P2-1)', () => {
  it('allows a minimal outcome with no pattern/suggestedAction', () => {
    const outcome: AlertVerdictOutcome = {
      classification: 'transient_self_healed',
      confidence: 0.9,
      rationale: 'cleared in 40s',
    };
    expect(outcome.classification).toBe('transient_self_healed');
    expect(outcome.pattern).toBeUndefined();
    expect(outcome.suggestedAction).toBeUndefined();
  });

  it('allows a full outcome with a pattern and a suggestedAction', () => {
    const outcome: AlertVerdictOutcome = {
      classification: 'recurring_pattern',
      confidence: 0.8,
      rationale: 'fires nightly around 02:00',
      pattern: { kind: 'daily', evidenceAlertIds: ['a1', 'a2'] },
      suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: 'a1', suppressDuration: 24 },
    };
    expect(outcome.pattern?.kind).toBe('daily');
    expect(outcome.suggestedAction?.action).toBe('suppress');
  });
});
