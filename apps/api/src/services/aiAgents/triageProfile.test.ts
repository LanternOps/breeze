// apps/api/src/services/aiAgents/triageProfile.test.ts
import { describe, expect, it } from 'vitest';
import {
  TRIAGE_OUTCOME_TOOL_NAME,
  TRIAGE_TOOL_ALLOWLIST,
  isTriageProfile,
  triageLimits,
  triageToolAllowlist,
} from './triageProfile';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { OUTCOME_TOOL_NAMES } from './outcomeTools';

describe('triage profile', () => {
  // Same design difference from `sweep`/`verdict` as `narrative`: a triage
  // run reads NOTHING live. Its whole input is the system-collected ticket
  // context assembled before the run, so there is no drill-down floor at
  // all — the model may call exactly one tool, the outcome tool. Duplicated
  // as a contract in `verdictProfile.contract.test.ts`.
  it('the read-only drill-down floor is EMPTY — a triage run reads no live data', () => {
    expect(TRIAGE_TOOL_ALLOWLIST).toEqual([]);
  });

  it('pins turns/budget to the triage limits and PASSES THROUGH maxActionsPerRun (post-run minting cap)', () => {
    const l = triageLimits({
      ...AI_AGENT_LIMIT_DEFAULTS,
      triageMaxTurns: 5,
      triageBudgetCentsPerRun: 12,
      maxActionsPerRun: 4,
    });
    expect(l.maxTurnsPerRun).toBe(5);
    expect(l.maxBudgetCentsPerRun).toBe(12);
    // Unlike verdict/sweep/narrative, triage does NOT zero this out: task A8's
    // finishRun uses it as a post-run cap on how many manage_tickets intents
    // one triage run's proposal may mint.
    expect(l.maxActionsPerRun).toBe(4);
  });

  // A policy snapshot resolved before the v8 limits bump carries no
  // triageMaxTurns/triageBudgetCentsPerRun at all — same tolerant-read
  // pattern as narrativeLimits' pre-v7 fallback test.
  it('falls back to AI_AGENT_LIMIT_DEFAULTS for a pre-v8 snapshot', () => {
    const { triageMaxTurns: _t, triageBudgetCentsPerRun: _b, ...preV8Limits } =
      AI_AGENT_LIMIT_DEFAULTS;
    const l = triageLimits(preV8Limits as typeof AI_AGENT_LIMIT_DEFAULTS);
    expect(l.maxTurnsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.triageMaxTurns);
    expect(l.maxBudgetCentsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.triageBudgetCentsPerRun);
    expect(l.maxBudgetCentsPerRun).not.toBeNaN();
    expect(l.maxTurnsPerRun).not.toBeNaN();
  });

  it('the allowlist is a floor that ignores the agent list and is the outcome tool alone', () => {
    expect(triageToolAllowlist(['manage_services', 'run_script']))
      .toEqual([TRIAGE_OUTCOME_TOOL_NAME]);
    expect(triageToolAllowlist([])).toEqual(['submit_ticket_proposal']);
  });

  it('agrees with outcomeTools.ts: TRIAGE_OUTCOME_TOOL_NAME is the registered submit_ticket_proposal entry', () => {
    const registered = (OUTCOME_TOOL_NAMES as readonly string[]).filter((n) => n === 'submit_ticket_proposal');
    expect(registered).toEqual([TRIAGE_OUTCOME_TOOL_NAME]);
  });

  it('isTriageProfile', () => {
    expect(isTriageProfile({ profile: 'triage' })).toBe(true);
    expect(isTriageProfile({ profile: 'full' })).toBe(false);
    expect(isTriageProfile({ profile: 'sweep' })).toBe(false);
    expect(isTriageProfile({ profile: 'verdict' })).toBe(false);
    expect(isTriageProfile({ profile: 'narrative' })).toBe(false);
  });
});
