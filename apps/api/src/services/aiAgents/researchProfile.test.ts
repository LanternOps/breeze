// apps/api/src/services/aiAgents/researchProfile.test.ts
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { TIER2_ACTIONS, TIER2_READONLY_TOOLS, TIER3_ACTIONS } from '../aiGuardrails';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import {
  RESEARCH_MODE_PROMPT, RESEARCH_TOOL_ALLOWLIST, researchDepthOf, researchLimits, researchToolAllowlist,
} from './researchProfile';

describe('remediation_research profile', () => {
  it('floor is exactly the spec list plus the outcome tool, whatever the agent allowlist', () => {
    expect(researchToolAllowlist(['run_script', 'propose_script'])).toEqual([
      'find_proven_fixes', 'get_device_details', 'get_device_context', 'search_logs', 'list_scripts', 'list_playbooks',
      'submit_suggestions',
    ]);
  });

  it('every floor tool is a tier-1 read (never propose_script, never an act tool)', () => {
    for (const name of RESEARCH_TOOL_ALLOWLIST) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS], name).toBe(1);
      expect(TIER3_ACTIONS[name], name).toBeUndefined();
      expect(TIER2_ACTIONS[name] === undefined || TIER2_READONLY_TOOLS.has(name), name).toBe(true);
    }
    expect(RESEARCH_TOOL_ALLOWLIST).not.toContain('propose_script');
  });

  it('pins turns and budget per depth; deep limits never leak into quick (Review Focus 3)', () => {
    const quick = researchLimits(AI_AGENT_LIMIT_DEFAULTS, 'quick');
    const deep = researchLimits(AI_AGENT_LIMIT_DEFAULTS, 'deep');
    expect(quick).toMatchObject({ maxTurnsPerRun: 4, maxBudgetCentsPerRun: 5, maxActionsPerRun: 0 });
    expect(deep).toMatchObject({ maxTurnsPerRun: 10, maxBudgetCentsPerRun: 25, maxActionsPerRun: 0 });
  });

  it('falls back to defaults on a pre-v16 snapshot', () => {
    const { researchQuickMaxTurns: _t, researchQuickBudgetCentsPerRun: _b, ...pre } = AI_AGENT_LIMIT_DEFAULTS;
    expect(researchLimits(pre as typeof AI_AGENT_LIMIT_DEFAULTS, 'quick')).toMatchObject({ maxTurnsPerRun: 4, maxBudgetCentsPerRun: 5 });
  });

  it('depth comes only from the server-written trigger ref and defaults to quick', () => {
    expect(researchDepthOf({ depth: 'deep' })).toBe('deep');
    expect(researchDepthOf({ depth: 'DEEP' })).toBe('quick');
    expect(researchDepthOf(null)).toBe('quick');
  });

  it('the fixed prompt says it cannot act, cannot draft, and must call submit_suggestions once', () => {
    expect(RESEARCH_MODE_PROMPT).toMatch(/cannot run, change or draft anything/i);
    expect(RESEARCH_MODE_PROMPT).toMatch(/draft_request/);
    expect(RESEARCH_MODE_PROMPT).toMatch(/submit_suggestions exactly once/);
  });
});
