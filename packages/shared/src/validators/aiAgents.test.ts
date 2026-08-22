import { describe, expect, it } from 'vitest';
import {
  aiAgentLimitsSchema,
  aiAgentPolicyFieldsSchema,
  createAiAgentSchema,
  updateAiAgentSchema,
} from './aiAgents';
import { AI_AGENT_LIMIT_DEFAULTS, minAgentMode } from '../types/aiAgents';

describe('aiAgents validators', () => {
  it('fills limit defaults and clamps maxima', () => {
    expect(aiAgentLimitsSchema.parse({})).toEqual(AI_AGENT_LIMIT_DEFAULTS);
    expect(aiAgentLimitsSchema.safeParse({ maxDevicesPerRun: 51 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ wallClockSeconds: 1801 }).success).toBe(false);
    expect(aiAgentLimitsSchema.safeParse({ maxDevicesPerRun: 0 }).success).toBe(false);
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

  it('minAgentMode picks the stricter mode', () => {
    expect(minAgentMode('act', 'shadow')).toBe('shadow');
    expect(minAgentMode('off', 'act')).toBe('off');
    expect(minAgentMode('act', 'act')).toBe('act');
  });
});
