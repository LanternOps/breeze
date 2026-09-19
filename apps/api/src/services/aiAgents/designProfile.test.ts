import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits } from '@breeze/shared';
import { DESIGN_TOOL_ALLOWLIST, designLimits, designToolAllowlist, isDesignProfile } from './designProfile';
import { buildAgentToolCatalog } from './agentToolCatalog';

/**
 * Tool names actually declared via `tool('<name>', ...)` in the single MCP
 * server (`createBreezeMcpServer`) a design run's `onlyTools` is validated
 * against — same approach as `declaredToolNames()` in
 * `aiAgentSdkTools.mcpCoverage.test.ts`. Being a `TOOL_TIERS` key (what the
 * "read-only catalog tool" test above checks) is NOT enough: a name can be
 * tiered and catalog-listed while only being declared on the separate
 * `script_builder` MCP server (`scriptBuilderTools.ts`), which is exactly
 * how `get_script_details` broke every design run at turn 0 (#createBreezeMcpServer
 * `onlyTools referenced unknown tool name(s)`).
 */
function declaredBreezeMcpToolNames(): Set<string> {
  const source = readFileSync(new URL('../aiAgentSdkTools.ts', import.meta.url), 'utf8');
  return new Set(Array.from(source.matchAll(/\btool\(\s*'([a-z0-9_]+)'/g), (m) => m[1]!));
}

describe('design profile', () => {
  it('detects the profile', () => {
    expect(isDesignProfile({ profile: 'design' })).toBe(true);
    expect(isDesignProfile({ profile: 'narrative' })).toBe(false);
  });
  it('substitutes design budget, turns and wall clock and zeroes actions', () => {
    const l = designLimits({
      ...AI_AGENT_LIMIT_DEFAULTS, designBudgetCentsPerRun: 500, designMaxTurns: 20, designWallClockSeconds: 1200,
    } as AiAgentLimits);
    expect(l.maxBudgetCentsPerRun).toBe(500);
    expect(l.maxTurnsPerRun).toBe(20);
    expect(l.wallClockSeconds).toBe(1200);
    expect(l.maxActionsPerRun).toBe(0);
    const legacy = designLimits({
      ...AI_AGENT_LIMIT_DEFAULTS, designMaxTurns: undefined, designWallClockSeconds: undefined,
    } as unknown as AiAgentLimits);
    expect(legacy.maxTurnsPerRun).toBe(AI_AGENT_LIMIT_DEFAULTS.designMaxTurns);
    expect(legacy.wallClockSeconds).toBe(AI_AGENT_LIMIT_DEFAULTS.designWallClockSeconds);
  });
  it('#5870: does not inherit the shared 600s wall clock default', () => {
    const l = designLimits(AI_AGENT_LIMIT_DEFAULTS);
    expect(l.wallClockSeconds).toBe(AI_AGENT_LIMIT_DEFAULTS.designWallClockSeconds);
    expect(l.wallClockSeconds).not.toBe(AI_AGENT_LIMIT_DEFAULTS.wallClockSeconds);
    expect(AI_AGENT_LIMIT_DEFAULTS.designWallClockSeconds).toBe(1800);
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
  it('every floor tool is declared in the breeze MCP server the design run actually attaches', () => {
    const declared = declaredBreezeMcpToolNames();
    const undeclared = DESIGN_TOOL_ALLOWLIST.filter((name) => !declared.has(name));
    expect(
      undeclared,
      'these names are TOOL_TIERS/catalog tools but createBreezeMcpServer never declares them '
        + '(e.g. they only exist on the separate script_builder MCP server) — onlyTools throws '
        + '"referenced unknown tool name(s)" at turn 0 for a design run',
    ).toEqual([]);
  });
});
