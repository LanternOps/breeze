// apps/api/src/services/aiAgents/assessmentProfile.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, AI_AGENT_RUN_PROFILES, WISP_CHECK_IN_TRIGGER_EVENTS, type AiAgentLimits } from '@breeze/shared';
import {
  ASSESSMENT_BUDGET_CENTS_PER_RUN,
  ASSESSMENT_MAX_CONCURRENT_RUNS,
  ASSESSMENT_MAX_RUNS_PER_HOUR,
  ASSESSMENT_MAX_TURNS,
  ASSESSMENT_TOOL_ALLOWLIST,
  ASSESSMENT_WALL_CLOCK_SECONDS,
  CHECK_IN_SUBJECT_READ_TOOLS,
  assessmentLimits,
  assessmentToolAllowlist,
  checkInSubjectOf,
  isAssessmentProfile,
  parseCheckInSubject,
} from './assessmentProfile';
import { AGENT_PROFILE_ROLE, agentRunModelRole } from './agentModelRole';
import { AGENT_KIND_PRESETS, listAgentReachableTools } from './agentToolCatalog';
import { classifyTerminal } from './agentCircuit';
import { outcomeToolsForProfile } from './outcomeTools';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { TIER1_READ_ACTIONS, TIER2_ACTIONS, TIER3_ACTIONS, TIER3_SUPERVISED_ACTIONS } from '../aiGuardrails';
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

  // #11425: an anomaly.incident_opened wake needs to drill into the device's
  // anomaly rows. manage_device_anomalies multiplexes list with writes
  // (dismiss/resolve tier 2, promote supervised), so it is admitted only
  // action-scoped to its read — the manage_alerts:list precedent.
  it('admits manage_device_anomalies only action-scoped to list', () => {
    expect(ASSESSMENT_TOOL_ALLOWLIST.filter((e) => baseName(e) === 'manage_device_anomalies')).toEqual(['manage_device_anomalies:list']);
    expect(assessmentToolAllowlist([])).not.toContain('manage_device_anomalies');
  });

  it('every action-scoped entry names a declared tier-1 READ action (TIER1_READ_ACTIONS), never a write', () => {
    const scoped = ASSESSMENT_TOOL_ALLOWLIST.filter((e) => e.includes(':'));
    expect(scoped.length).toBeGreaterThan(0);
    const writes = [TIER2_ACTIONS, TIER3_ACTIONS, TIER3_SUPERVISED_ACTIONS];
    for (const entry of scoped) {
      const [tool, action] = entry.split(':') as [string, string];
      expect(TIER1_READ_ACTIONS[tool] ?? [], `${entry} is not a declared tier-1 read`).toContain(action);
      for (const map of writes) expect(map[tool] ?? [], `${entry} is a write action`).not.toContain(action);
    }
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

  // #11978: a run_settled check-in must be able to read the run it waits on.
  describe('check-in subject reads (#11978)', () => {
    const ID = '00000000-0000-4000-8000-0000000000a1';
    const ref = (subject: unknown) => ({ wisp: { reason: { kind: 'check_in', checkInId: ID, instruction: 'x', evidence: null, subject } } });

    it('classifies every trigger event, and every read is tier 1, registered, agent-reachable and MCP-declared', () => {
      expect(Object.keys(CHECK_IN_SUBJECT_READ_TOOLS).sort()).toEqual([...WISP_CHECK_IN_TRIGGER_EVENTS].sort());
      expect(CHECK_IN_SUBJECT_READ_TOOLS.run_settled).toContain('get_ai_agent_run');
      const registered = new Set(getAllRegisteredToolNames());
      const reachable = new Set(listAgentReachableTools());
      const declared = declaredBreezeMcpToolNames();
      const tiers = TOOL_TIERS as Readonly<Record<string, number>>;
      for (const entry of Object.values(CHECK_IN_SUBJECT_READ_TOOLS).flat()) {
        expect(entry, 'no action-scoped subject reads').not.toContain(':');
        expect(registered.has(entry), `${entry} is not registered in aiTools`).toBe(true);
        expect(tiers[entry], `${entry} base tier`).toBe(1);
        expect(reachable.has(entry), `${entry} is not agent-reachable`).toBe(true);
        expect(declared.has(entry), `${entry} is not declared on the breeze MCP server`).toBe(true);
        expect(ASSESSMENT_TOOL_ALLOWLIST, `${entry} is already on the floor`).not.toContain(entry);
      }
    });

    it('a check-in run gets exactly its subject\'s reads ahead of the outcome tools', () => {
      const floor = assessmentToolAllowlist([]);
      expect(assessmentToolAllowlist([], ref({ kind: 'run_settled', id: ID }))).toEqual([
        ...ASSESSMENT_TOOL_ALLOWLIST, 'get_ai_agent_run', ...outcomeToolsForProfile('assessment'),
      ]);
      expect(assessmentToolAllowlist([], ref({ kind: 'device_online', id: ID }))).toEqual(floor);
      expect(assessmentToolAllowlist([], null)).toEqual(floor);
      // Only a check_in reason carries a subject.
      expect(assessmentToolAllowlist([], { wisp: { reason: { kind: 'tick', subject: { kind: 'run_settled', id: ID } } } })).toEqual(floor);
    });

    it('parseCheckInSubject / checkInSubjectOf accept only a trigger event and a uuid', () => {
      expect(parseCheckInSubject({ kind: 'run_settled', id: ID })).toEqual({ kind: 'run_settled', id: ID });
      expect(parseCheckInSubject({ kind: 'run_settled', id: ID, extra: 1 })).toEqual({ kind: 'run_settled', id: ID });
      for (const bad of [null, undefined, 'run_settled', { kind: 'time', id: ID }, { kind: 'toString', id: ID }, { kind: 'run_settled', id: 'x' }, { kind: 'run_settled' }]) {
        expect(parseCheckInSubject(bad)).toBeNull();
      }
      expect(checkInSubjectOf(ref({ kind: 'run_settled', id: ID }))).toEqual({ kind: 'run_settled', id: ID });
      expect(checkInSubjectOf(undefined)).toBeNull();
      expect(checkInSubjectOf({ wisp: null })).toBeNull();
    });
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
