import { describe, expect, it } from 'vitest';
import {
  aiAgentActAssetsSchema,
  aiAgentLimitsSchema,
  aiAgentPolicyFieldsSchema,
  aiAgentTriggersPatchSchema,
  alertVerdictOutcomeSchema,
  createAiAgentSchema,
  updateAiAgentSchema,
} from './aiAgents';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_POLICY_SNAPSHOT_VERSION,
  AI_AGENT_TRIGGER_KINDS,
  SUPPORTED_AGENT_MODES,
  minAgentMode,
} from '../types/aiAgents';

describe('aiAgents validators', () => {
  it("AI_AGENT_TRIGGER_KINDS includes 'anomaly' (wave 6 PR 4, #3828)", () => {
    expect(AI_AGENT_TRIGGER_KINDS).toContain('anomaly');
  });

  it('fills limit defaults and clamps maxima', () => {
    expect(aiAgentLimitsSchema.parse({})).toEqual(AI_AGENT_LIMIT_DEFAULTS);
    expect(aiAgentLimitsSchema.safeParse({ maxDevicesPerRun: 51 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ wallClockSeconds: 1801 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxDevicesPerRun: 0 }).success).toBe(false);
  });

  it('maxActionsPerRun defaults to 3 and clamps to [1,10]', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun).toBe(3);
    expect(aiAgentLimitsSchema.parse({}).maxActionsPerRun).toBe(3);
    expect(aiAgentLimitsSchema.safeParse({ maxActionsPerRun: 1 }).success).toBe(true);
    expect(aiAgentLimitsSchema.safeParse({ maxActionsPerRun: 10 }).success).toBe(true);
    expect(aiAgentLimitsSchema.safeParse({ maxActionsPerRun: 0 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxActionsPerRun: 11 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxActionsPerRun: 2.5 }).success).toBe(false);
  });

  it('maxPolicyDecisionsPerDay defaults to 10 and clamps to [1,200] (wave 5 Part A, #3827)', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxPolicyDecisionsPerDay).toBe(10);
    expect(aiAgentLimitsSchema.parse({}).maxPolicyDecisionsPerDay).toBe(10);
    expect(aiAgentLimitsSchema.safeParse({ maxPolicyDecisionsPerDay: 1 }).success).toBe(true);
    expect(aiAgentLimitsSchema.safeParse({ maxPolicyDecisionsPerDay: 200 }).success).toBe(true);
    expect(aiAgentLimitsSchema.safeParse({ maxPolicyDecisionsPerDay: 0 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxPolicyDecisionsPerDay: 201 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxPolicyDecisionsPerDay: 2.5 }).success).toBe(false);
  });

  it('maxConsecutiveFailures defaults to 3 and clamps to [1,10], no 0-disables (wave 6 PR 2, #3828)', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxConsecutiveFailures).toBe(3);
    expect(aiAgentLimitsSchema.parse({}).maxConsecutiveFailures).toBe(3);
    expect(aiAgentLimitsSchema.safeParse({ maxConsecutiveFailures: 1 }).success).toBe(true);
    expect(aiAgentLimitsSchema.safeParse({ maxConsecutiveFailures: 10 }).success).toBe(true);
    expect(aiAgentLimitsSchema.safeParse({ maxConsecutiveFailures: 0 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxConsecutiveFailures: 11 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxConsecutiveFailures: 2.5 }).success).toBe(false);
  });

  it('maxVerdictRunsPerHour/maxConcurrentVerdictRuns/verdictBudgetCentsPerRun default-fill on an empty parse (phase 2 P2-1)', () => {
    const parsed = aiAgentLimitsSchema.parse({});
    expect(parsed.maxVerdictRunsPerHour).toBe(200);
    expect(parsed.maxConcurrentVerdictRuns).toBe(4);
    expect(parsed.verdictBudgetCentsPerRun).toBe(2);
  });

  it('AI_AGENT_POLICY_SNAPSHOT_VERSION is 5 (phase 2 P2-1 bump)', () => {
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(5);
  });

  it('rejects instructions over 2000 chars and unknown allowlist shapes', () => {
    expect(aiAgentPolicyFieldsSchema.safeParse({ instructions: 'x'.repeat(2001) }).success).toBe(false);
    expect(aiAgentPolicyFieldsSchema.safeParse({ toolAllowlist: ['run_script', 'manage_services:restart'] }).success).toBe(true);
    expect(aiAgentPolicyFieldsSchema.safeParse({ toolAllowlist: ['bad tool name!'] }).success).toBe(false);
  });

  it('create requires kind + name; update forbids ownerScope/kind/orgId', () => {
    expect(createAiAgentSchema.safeParse({ name: 'Triage' }).success).toBe(false);
    expect(createAiAgentSchema.safeParse({ kind: 'triage', name: 'Triage', ownerScope: 'partner' }).success).toBe(true);
    const parsed = updateAiAgentSchema.parse({ ownerScope: 'partner', kind: 'patch', orgId: 'x', name: 'New' });
    expect(parsed).toEqual({ name: 'New' });
  });

  it('a PATCH never invents a value the caller did not send — at any depth', () => {
    // Regression: per-field .default() on the nested schemas meant a PATCH of
    // one guardrail path came back with services/registryKeys reset to [],
    // silently erasing an act-mode agent's protections. Same shape of bug reset
    // limits siblings and dropped triggers scoping (widening blast radius).
    expect(updateAiAgentSchema.parse({ protectedResources: { paths: ['/etc'] } })).toEqual({
      protectedResources: { paths: ['/etc'] },
    });
    expect(updateAiAgentSchema.parse({ limits: { maxDevicesPerRun: 5 } })).toEqual({
      limits: { maxDevicesPerRun: 5 },
    });
    expect(updateAiAgentSchema.parse({ triggers: { alertSeverities: ['low'] } })).toEqual({
      triggers: { alertSeverities: ['low'] },
    });
    expect(updateAiAgentSchema.parse({})).toEqual({});
    // ...while still validating the keys it IS given.
    expect(updateAiAgentSchema.safeParse({ limits: { maxDevicesPerRun: 51 } }).success).toBe(false);
  });

  it('create still materializes complete nested objects', () => {
    const created = createAiAgentSchema.parse({ kind: 'triage', name: 'Triage' });
    expect(created.limits).toEqual(AI_AGENT_LIMIT_DEFAULTS);
    expect(created.protectedResources).toEqual({ services: [], paths: [], registryKeys: [], deviceTags: [] });
    expect(created.recipients).toEqual({ userIds: [], roleIds: [] });
    expect(created.triggers.alertSeverities).toEqual(['critical', 'high']);
  });

  it('recipients target roles by id, and narrowing lists reject the empty array', () => {
    expect(aiAgentPolicyFieldsSchema.safeParse({ recipients: { roleIds: ['not-a-uuid'] } }).success).toBe(false);
    // [] would read as "matches nothing" — the opposite of "unrestricted".
    expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { siteIds: [] } }).success).toBe(false);
  });

  describe('triggers.ticketCategories / triggers.ticketPriorities (wave 6 PR 3, #3828)', () => {
    it('are absent (unrestricted) by default — no default value is invented', () => {
      const created = createAiAgentSchema.parse({ kind: 'helpdesk', name: 'Helpdesk' });
      expect(created.triggers.ticketCategories).toBeUndefined();
      expect(created.triggers.ticketPriorities).toBeUndefined();
    });

    it('accepts a narrowing list of categories/priorities', () => {
      const parsed = aiAgentPolicyFieldsSchema.parse({
        triggers: { ticketCategories: ['hardware', 'network'], ticketPriorities: ['high', 'urgent'] },
      });
      expect(parsed.triggers.ticketCategories).toEqual(['hardware', 'network']);
      expect(parsed.triggers.ticketPriorities).toEqual(['high', 'urgent']);
    });

    it('rejects the empty array for both — [] would read as "matches nothing"', () => {
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { ticketCategories: [] } }).success).toBe(false);
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { ticketPriorities: [] } }).success).toBe(false);
    });

    it('rejects a priority value outside the ticket_priority enum', () => {
      const result = aiAgentPolicyFieldsSchema.safeParse({ triggers: { ticketPriorities: ['critical'] } });
      expect(result.success).toBe(false);
    });
  });

  describe('triggers.anomalyTypes / metricNames / minAnomalyScore (wave 6 PR 4, #3828)', () => {
    it('are absent (unrestricted) by default — no default value is invented', () => {
      const created = createAiAgentSchema.parse({ kind: 'triage', name: 'Triage' });
      expect(created.triggers.anomalyTypes).toBeUndefined();
      expect(created.triggers.metricNames).toBeUndefined();
      expect(created.triggers.minAnomalyScore).toBeUndefined();
    });

    it('accepts a narrowing list of anomaly types/metric names and a score floor', () => {
      const parsed = aiAgentPolicyFieldsSchema.parse({
        triggers: { anomalyTypes: ['spike', 'drop'], metricNames: ['cpu_percent'], minAnomalyScore: 2.5 },
      });
      expect(parsed.triggers.anomalyTypes).toEqual(['spike', 'drop']);
      expect(parsed.triggers.metricNames).toEqual(['cpu_percent']);
      expect(parsed.triggers.minAnomalyScore).toBe(2.5);
    });

    it('rejects the empty array for anomalyTypes/metricNames — [] would read as "matches nothing"', () => {
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { anomalyTypes: [] } }).success).toBe(false);
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { metricNames: [] } }).success).toBe(false);
    });

    it('rejects a negative minAnomalyScore (unbounded-above, floor-only domain)', () => {
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { minAnomalyScore: -1 } }).success).toBe(false);
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { minAnomalyScore: 0 } }).success).toBe(true);
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { minAnomalyScore: 999 } }).success).toBe(true);
    });

    it('accepts free-text anomaly types beyond the current spike/drop/trend set — not a fixed enum', () => {
      const result = aiAgentPolicyFieldsSchema.safeParse({ triggers: { anomalyTypes: ['future_type'] } });
      expect(result.success).toBe(true);
    });
  });

  describe('triggers.anomalyEnabled — conservative per-agent opt-in (wave 6 PR 4 follow-up, #3828)', () => {
    it('defaults to false — NOT the "absent = unrestricted" convention every other narrowing filter uses', () => {
      const created = createAiAgentSchema.parse({ kind: 'triage', name: 'Triage' });
      expect(created.triggers.anomalyEnabled).toBe(false);
    });

    it('a patch omitting anomalyEnabled leaves it unset (no invented default on the patch variant)', () => {
      const parsed = aiAgentTriggersPatchSchema.parse({});
      expect(parsed.anomalyEnabled).toBeUndefined();
    });

    it('accepts an explicit true/false', () => {
      expect(aiAgentPolicyFieldsSchema.parse({ triggers: { anomalyEnabled: true } }).triggers.anomalyEnabled)
        .toBe(true);
      expect(aiAgentPolicyFieldsSchema.parse({ triggers: { anomalyEnabled: false } }).triggers.anomalyEnabled)
        .toBe(false);
    });

    it('rejects a non-boolean value', () => {
      expect(aiAgentPolicyFieldsSchema.safeParse({ triggers: { anomalyEnabled: 'true' } }).success).toBe(false);
    });
  });

  it('minAgentMode picks the stricter mode', () => {
    expect(minAgentMode('act', 'shadow')).toBe('shadow');
    expect(minAgentMode('off', 'act')).toBe('off');
    expect(minAgentMode('act', 'act')).toBe('act');
  });

  it("SUPPORTED_AGENT_MODES admits 'act' (Task 6, #3826)", () => {
    expect([...SUPPORTED_AGENT_MODES].sort()).toEqual(['act', 'off', 'shadow']);
  });

  describe('actAssets — per-script act authorization', () => {
    it('defaults to an empty scriptIds and supervisedActionKeys list', () => {
      expect(aiAgentActAssetsSchema.parse({})).toEqual({ scriptIds: [], supervisedActionKeys: [] });
      expect(aiAgentPolicyFieldsSchema.parse({}).actAssets).toEqual({
        scriptIds: [],
        supervisedActionKeys: [],
      });
    });

    it('accepts up to 50 uuid scriptIds and rejects non-uuid entries', () => {
      const uuid = '11111111-1111-4111-8111-111111111111';
      expect(aiAgentActAssetsSchema.safeParse({ scriptIds: [uuid] }).success).toBe(true);
      expect(aiAgentActAssetsSchema.safeParse({ scriptIds: ['not-a-uuid'] }).success).toBe(false);
      expect(aiAgentActAssetsSchema.safeParse({ scriptIds: Array(51).fill(uuid) }).success).toBe(false);
    });

    it('a PATCH of actAssets does not invent siblings and update forbids nothing else', () => {
      const uuid = '22222222-2222-4222-8222-222222222222';
      expect(updateAiAgentSchema.parse({ actAssets: { scriptIds: [uuid] } })).toEqual({
        actAssets: { scriptIds: [uuid] },
      });
    });

    it('create materializes actAssets with the empty default', () => {
      const created = createAiAgentSchema.parse({ kind: 'triage', name: 'Triage' });
      expect(created.actAssets).toEqual({ scriptIds: [], supervisedActionKeys: [] });
    });
  });

  describe('actAssets.supervisedActionKeys — wave 5 Part B (#3827) shape only', () => {
    it('accepts a bare-tool or tool:action key (TOOL_REF format) and rejects a malformed one', () => {
      expect(aiAgentActAssetsSchema.safeParse({ supervisedActionKeys: ['manage_services:restart'] }).success)
        .toBe(true);
      expect(aiAgentActAssetsSchema.safeParse({ supervisedActionKeys: ['security_scan'] }).success).toBe(true);
      expect(aiAgentActAssetsSchema.safeParse({ supervisedActionKeys: ['Not Valid!'] }).success).toBe(false);
      expect(aiAgentActAssetsSchema.safeParse({ supervisedActionKeys: ['a:b:c'] }).success).toBe(false);
    });

    it('caps at 50 entries', () => {
      const keys = Array(50).fill('manage_services:restart');
      expect(aiAgentActAssetsSchema.safeParse({ supervisedActionKeys: keys }).success).toBe(true);
      expect(aiAgentActAssetsSchema.safeParse({ supervisedActionKeys: [...keys, 'security_scan:remove'] }).success)
        .toBe(false);
    });

    it('a PATCH of only supervisedActionKeys does not invent scriptIds', () => {
      expect(updateAiAgentSchema.parse({ actAssets: { supervisedActionKeys: ['security_scan:quarantine'] } }))
        .toEqual({ actAssets: { supervisedActionKeys: ['security_scan:quarantine'] } });
    });

    it('does NOT perform registry/four_eyes/secret semantic rejection — that is API-only (agentService.ts)', () => {
      // Shared has no access to POLICY_DECIDABLE_TIER3 / aiGuardrails.ts, so an
      // unregistered-but-TOOL_REF-shaped key passes shape validation here; the
      // write-time 422 comes from validateAuthorizationKeys in the API layer.
      expect(aiAgentActAssetsSchema.safeParse({ supervisedActionKeys: ['not_a_real_tool:whatever'] }).success)
        .toBe(true);
    });
  });
});

describe('alertVerdictOutcomeSchema', () => {
  it('accepts a minimal verdict and caps rationale at 400 chars', () => {
    expect(alertVerdictOutcomeSchema.safeParse({
      classification: 'transient_self_healed', confidence: 0.9, rationale: 'cleared in 40s',
    }).success).toBe(true);
    expect(alertVerdictOutcomeSchema.safeParse({
      classification: 'actionable', confidence: 0.5, rationale: 'x'.repeat(401),
    }).success).toBe(false);
  });
  it('rejects unknown classifications, out-of-range confidence, and suggestions for other tools', () => {
    expect(alertVerdictOutcomeSchema.safeParse({ classification: 'bogus', confidence: 0.5, rationale: 'r' }).success).toBe(false);
    expect(alertVerdictOutcomeSchema.safeParse({ classification: 'actionable', confidence: 1.5, rationale: 'r' }).success).toBe(false);
    expect(alertVerdictOutcomeSchema.safeParse({
      classification: 'actionable', confidence: 0.5, rationale: 'r',
      suggestedAction: { tool: 'run_script', action: 'run', alertId: '0f2e2c7e-0c7d-4f7e-9c1c-1f4f2c1a9b10' },
    }).success).toBe(false);
  });
  it('bounds suppressDuration to 0..720 hours', () => {
    const base = { classification: 'recurring_pattern', confidence: 0.8, rationale: 'nightly' };
    const id = '0f2e2c7e-0c7d-4f7e-9c1c-1f4f2c1a9b10';
    expect(alertVerdictOutcomeSchema.safeParse({ ...base, suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: id, suppressDuration: 24 } }).success).toBe(true);
    expect(alertVerdictOutcomeSchema.safeParse({ ...base, suggestedAction: { tool: 'manage_alerts', action: 'suppress', alertId: id, suppressDuration: 721 } }).success).toBe(false);
  });
});

describe('limits v5', () => {
  it('has verdict defaults and bounds', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxVerdictRunsPerHour).toBe(200);
    expect(AI_AGENT_LIMIT_DEFAULTS.maxConcurrentVerdictRuns).toBe(4);
    expect(AI_AGENT_LIMIT_DEFAULTS.verdictBudgetCentsPerRun).toBe(2);
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(5);
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, maxVerdictRunsPerHour: 2001 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, maxConcurrentVerdictRuns: 0 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ ...AI_AGENT_LIMIT_DEFAULTS, verdictBudgetCentsPerRun: 51 }).success).toBe(false);
  });
});
