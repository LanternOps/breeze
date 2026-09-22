import { describe, expect, it } from 'vitest';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_POLICY_SNAPSHOT_VERSION,
  AI_AGENT_RUN_PROFILES,
  ANALYSIS_FINDING_SEVERITIES,
  type AiAgentPolicySnapshot,
  type AnalysisOutcome,
  type AlertVerdictOutcome,
  type AlertVerdictSuggestedAction,
} from './aiAgents';

describe('AI_AGENT_POLICY_SNAPSHOT_VERSION (v15, AI Operator task-wide budgets — recipe library E2)', () => {
  it('is the literal 15', () => {
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(15);
  });

  it('AiAgentPolicySnapshot.schemaVersion type-accepts every historical version 1-15', () => {
    // Type-level assertion: this only compiles if `schemaVersion` is widened
    // to `1 | … | 15`. If a future bump forgets to widen the union, `tsc`
    // fails this assignment, not a runtime check.
    const versions: Array<AiAgentPolicySnapshot['schemaVersion']> =
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe('AI_AGENT_LIMIT_DEFAULTS (AI Operator task-wide budgets, v15 — Operator spec §7.2)', () => {
  it('carries spec §7.2 proposed defaults verbatim', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.taskMaxReasoningRuns).toBe(4);
    expect(AI_AGENT_LIMIT_DEFAULTS.taskMaxMutationAttemptsPerTarget).toBe(3);
    expect(AI_AGENT_LIMIT_DEFAULTS.taskMaxBudgetCents).toBe(200);
    expect(AI_AGENT_LIMIT_DEFAULTS.taskDeadlineHours).toBe(72);
    expect(AI_AGENT_LIMIT_DEFAULTS.taskMaxActiveTargets).toBe(1);
    expect(AI_AGENT_LIMIT_DEFAULTS.taskMaxPendingPerOrg).toBe(100);
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

describe('AI_AGENT_LIMIT_DEFAULTS (patch-profile limits, AI patch agent W04 #5750)', () => {
  it('sizes maxPatchRunsPerDay for the nightly occurrence plus reactive alert runs', () => {
    // W04 routes patch-classified alerts into the same daily budget; 2 would
    // let two alerts starve the scheduled occurrence.
    expect(AI_AGENT_LIMIT_DEFAULTS.maxPatchRunsPerDay).toBe(6);
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

describe('AI_AGENT_RUN_PROFILES (analysis profile, execution plane W04 #5715)', () => {
  it('equals full, verdict, sweep, narrative, triage, design, patch, analysis', () => {
    expect(AI_AGENT_RUN_PROFILES).toEqual([
      'full', 'verdict', 'sweep', 'narrative', 'triage', 'design', 'patch', 'analysis',
    ]);
  });
});

describe('analysis profile limits (execution plane W04, spec §5.4)', () => {
  it('carries the spec §5.4 defaults', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxInputDevicesPerRun).toBe(50);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxTurnsPerRun).toBe(40);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisWallClockSeconds).toBe(900);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxComputeSeconds).toBe(600);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxComputeCentsPerRun).toBe(25);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxStagedBytesPerRun).toBe(256 * 1024 * 1024);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxArtifactBytesPerRun).toBe(128 * 1024 * 1024);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxBudgetCentsPerRun).toBe(150);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxRunsPerHour).toBe(10);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxConcurrentRuns).toBe(2);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxStepTimeoutSeconds).toBe(300);
    expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxStepsPerRun).toBe(40);
  });

  it('types an AnalysisOutcome with findings and proposed actions', () => {
    const outcome: AnalysisOutcome = {
      summary: 'three devices share a failing disk model',
      findings: [{
        title: 'SMART pre-fail on 3 devices',
        severity: 'high',
        detail: 'reallocated sector count climbing on ST2000-series',
        artifactHandles: ['11111111-1111-4111-8111-111111111111'],
      }],
      artifactHandles: ['11111111-1111-4111-8111-111111111111'],
      proposedActions: [{
        tool: 'manage_alerts',
        action: 'resolve',
        deviceId: '22222222-2222-4222-8222-222222222222',
        args: { alertId: '33333333-3333-4333-8333-333333333333' },
        rationale: 'superseded by the disk finding',
      }],
    };
    expect(outcome.findings[0]?.severity).toBe('high');
    expect(ANALYSIS_FINDING_SEVERITIES).toEqual(['info', 'low', 'medium', 'high']);
  });
});

describe('AI_AGENT_LIMIT_DEFAULTS (promoteThreshold, phase 2 P2-5)', () => {
  it('defaults to 20', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.promoteThreshold).toBe(20);
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
