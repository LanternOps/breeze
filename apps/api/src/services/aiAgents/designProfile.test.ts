import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits } from '@breeze/shared';
import { DESIGN_TOOL_ALLOWLIST, designLimits, designToolAllowlist, isDesignProfile } from './designProfile';
import { buildAgentToolCatalog } from './agentToolCatalog';

describe('design profile', () => {
  it('detects the profile', () => {
    expect(isDesignProfile({ profile: 'design' })).toBe(true);
    expect(isDesignProfile({ profile: 'narrative' })).toBe(false);
  });
  it('substitutes design budget and turns and zeroes actions', () => {
    const l = designLimits({ ...AI_AGENT_LIMIT_DEFAULTS, designBudgetCentsPerRun: 500, designMaxTurns: 20 } as AiAgentLimits);
    expect(l.maxBudgetCentsPerRun).toBe(500);
    expect(l.maxTurnsPerRun).toBe(20);
    expect(l.maxActionsPerRun).toBe(0);
    const legacy = designLimits({ ...AI_AGENT_LIMIT_DEFAULTS, designMaxTurns: undefined } as unknown as AiAgentLimits);
    expect(legacy.maxTurnsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.designMaxTurns);
  });
  it('is a floor: ignores the agent allowlist, ends with the outcome tool', () => {
    const list = designToolAllowlist(['run_script']);
    expect(list).not.toContain('run_script');
    expect(list[list.length - 1]).toBe('submit_fleet_design');
    expect(list.slice(0, -1)).toEqual([...DESIGN_TOOL_ALLOWLIST]);
  });
  it('every floor tool is a read-only catalog tool (spec §4.12)', () => {
    const catalog = buildAgentToolCatalog();
    const byName = new Map(catalog.tools.map((t) => [t.name, t]));
    for (const name of DESIGN_TOOL_ALLOWLIST) {
      const tool = byName.get(name);
      expect(tool, `${name} is not a catalog tool`).toBeDefined();
      expect(tool!.readOnly, `${name} must be read-only`).toBe(true);
    }
  });
});
