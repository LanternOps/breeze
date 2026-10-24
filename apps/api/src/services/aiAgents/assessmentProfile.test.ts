// apps/api/src/services/aiAgents/assessmentProfile.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, AI_AGENT_RUN_PROFILES, type AiAgentLimits } from '@breeze/shared';
import {
  ASSESSMENT_BUDGET_CENTS_PER_RUN,
  ASSESSMENT_MAX_CONCURRENT_RUNS,
  ASSESSMENT_MAX_RUNS_PER_HOUR,
  ASSESSMENT_MAX_TURNS,
  ASSESSMENT_TOOL_ALLOWLIST,
  ASSESSMENT_WALL_CLOCK_SECONDS,
  assessmentLimits,
  assessmentToolAllowlist,
  isAssessmentProfile,
} from './assessmentProfile';
import { AGENT_PROFILE_ROLE, agentRunModelRole } from './agentModelRole';
import { AGENT_KIND_PRESETS, listAgentReachableTools } from './agentToolCatalog';
import { classifyTerminal } from './agentCircuit';
import { outcomeToolsForProfile } from './outcomeTools';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { getAllRegisteredToolNames } from '../aiTools';

/** Same approach as designProfile.test.ts: names declared via `tool('<name>', …)` in aiAgentSdkTools.ts. */
function declaredBreezeMcpToolNames(): Set<string> {
  const source = readFileSync(new URL('../aiAgentSdkTools.ts', import.meta.url), 'utf8');
  return new Set(Array.from(source.matchAll(/\btool\(\s*'([a-z0-9_]+)'/g), (m) => m[1]!));
}

/** `tool:action` entries name the base tool (toolAllowlist.ts matching rule). */
const baseName = (entry: string): string => entry.split(':')[0]!;

describe('assessment profile (Wisp W05)', () => {
  it('AI_AGENT_RUN_PROFILES contains assessment and AGENT_PROFILE_ROLE maps it to triage', () => {
    expect(AI_AGENT_RUN_PROFILES).toContain('assessment');
    expect(AGENT_PROFILE_ROLE.assessment).toBe('triage');
    // Never act-mode remediation: an assessment proposes through outcome tools.
    expect(agentRunModelRole({ profile: 'assessment', modeAtStart: 'act' })).toBe('triage');
  });

  it('pins the w00 constants', () => {
    expect(ASSESSMENT_MAX_TURNS).toBe(15);
    expect(ASSESSMENT_BUDGET_CENTS_PER_RUN).toBe(25);
    expect(ASSESSMENT_WALL_CLOCK_SECONDS).toBe(300);
    expect(ASSESSMENT_MAX_CONCURRENT_RUNS).toBe(1);
    expect(ASSESSMENT_MAX_RUNS_PER_HOUR).toBe(6);
  });

  it('assessmentLimits pins 15 turns / 25 cents / 300 s / 0 actions and passes everything else through', () => {
    const input: AiAgentLimits = {
      ...AI_AGENT_LIMIT_DEFAULTS,
      maxTurnsPerRun: 99,
      maxBudgetCentsPerRun: 999,
      wallClockSeconds: 1234,
      maxActionsPerRun: 7,
      maxRunsPerHour: 42,
      maxBudgetCentsPerDay: 4321,
    };
    const l = assessmentLimits(input);
    expect(l.maxTurnsPerRun).toBe(15);
    expect(l.maxBudgetCentsPerRun).toBe(25);
    expect(l.wallClockSeconds).toBe(300);
    expect(l.maxActionsPerRun).toBe(0);
    const { maxTurnsPerRun: _t, maxBudgetCentsPerRun: _b, wallClockSeconds: _w, maxActionsPerRun: _a, ...rest } = l;
    const { maxTurnsPerRun: _t2, maxBudgetCentsPerRun: _b2, wallClockSeconds: _w2, maxActionsPerRun: _a2, ...restIn } = input;
    expect(rest).toEqual(restIn);
    // Does not mutate its input.
    expect(input.maxTurnsPerRun).toBe(99);
  });

  it('assessmentToolAllowlist is read-only: every name is registered and its TOOL_TIERS base tier is 1', () => {
    expect(ASSESSMENT_TOOL_ALLOWLIST.length).toBeGreaterThan(0);
    const registered = new Set(getAllRegisteredToolNames());
    const reachable = new Set(listAgentReachableTools());
    const declared = declaredBreezeMcpToolNames();
    const tiers = TOOL_TIERS as Readonly<Record<string, number>>;
    for (const entry of ASSESSMENT_TOOL_ALLOWLIST) {
      const name = baseName(entry);
      expect(registered.has(name), `${entry} is not registered in aiTools`).toBe(true);
      expect(tiers[name], `${entry} base tier`).toBe(1);
      expect(reachable.has(name), `${entry} is not agent-reachable`).toBe(true);
      expect(declared.has(name), `${entry} is not declared on the breeze MCP server`).toBe(true);
    }
    expect(ASSESSMENT_TOOL_ALLOWLIST).toContain('recall');
    expect(new Set(ASSESSMENT_TOOL_ALLOWLIST).size).toBe(ASSESSMENT_TOOL_ALLOWLIST.length);
    // Multiplexed tools appear only action-scoped to their read actions.
    expect(ASSESSMENT_TOOL_ALLOWLIST).not.toContain('manage_alerts');
    expect(ASSESSMENT_TOOL_ALLOWLIST).not.toContain('remember');
  });

  it('assessmentToolAllowlist is a floor: the agent allowlist neither widens nor (being a mutation list) empties it', () => {
    const floor = [...ASSESSMENT_TOOL_ALLOWLIST, ...outcomeToolsForProfile('assessment')];
    expect(assessmentToolAllowlist([])).toEqual(floor);
    // The triage preset is all mutations; reads bypass agent allowlists in the
    // guardrail, so intersecting would strand the run with no reads at all.
    expect(assessmentToolAllowlist([...AGENT_KIND_PRESETS.triage])).toEqual(floor);
    const widened = assessmentToolAllowlist(['run_script', 'manage_alerts', 'remember']);
    expect(widened).not.toContain('run_script');
    expect(widened).not.toContain('manage_alerts');
    expect(widened).not.toContain('remember');
  });

  it('isAssessmentProfile', () => {
    expect(isAssessmentProfile({ profile: 'assessment' })).toBe(true);
    expect(isAssessmentProfile({ profile: 'triage' })).toBe(false);
    expect(isAssessmentProfile({ profile: 'full' })).toBe(false);
  });

  it('classifyTerminal("completed", null, "needs_attention", "assessment") is neutral', () => {
    expect(classifyTerminal('completed', null, 'needs_attention', 'assessment')).toBe('neutral');
    expect(classifyTerminal('awaiting_approval', null, null, 'assessment')).toBe('neutral');
    // failed stays profile-independent.
    expect(classifyTerminal('failed', 'stalled', null, 'assessment')).toBe('neutral');
  });
});
