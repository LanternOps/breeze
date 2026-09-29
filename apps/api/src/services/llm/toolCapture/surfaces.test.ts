import { describe, expect, it } from 'vitest';
import { BREEZE_MCP_TOOL_NAMES, listChatSurfaceToolNames } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames, getHelperAllowedTools } from '../../helperToolFilter';
import { declaredFullRunToolExposure, resolveRunProfileLimits, resolveRunToolExposure } from '../../aiAgents/runLoop';
import { ANALYSIS_TOOL_ALLOWLIST } from '../../aiAgents/analysisProfile';
import { OUTCOME_MCP_TOOL_NAMES } from '../../aiAgents/outcomeTools';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import { CAPTURE_SURFACES, REPRESENTATIVE_REMEDIATION_ALLOWLIST } from './surfaces';

describe('CAPTURE_SURFACES derive from the surfaces\' own exports', () => {
  it('chat registers the whole TOOL_TIERS surface and is the only surface that may use tool search', () => {
    expect(CAPTURE_SURFACES.chat.allowedTools).toEqual(BREEZE_MCP_TOOL_NAMES);
    expect(CAPTURE_SURFACES.chat.onlyTools).toBeUndefined();
    expect(CAPTURE_SURFACES.chat.toolSearch).toBe(true);
    for (const s of Object.values(CAPTURE_SURFACES).filter((x) => x.id !== 'chat')) expect(s.toolSearch, s.id).toBe(false);
  });

  it('agent-full registers and allows the declared full-profile exposure of a read-only agent (empty allowlist, #7427)', () => {
    const exposure = declaredFullRunToolExposure([]);
    expect([...CAPTURE_SURFACES['agent-full'].onlyTools!].sort()).toEqual([...exposure].sort());
    expect(CAPTURE_SURFACES['agent-full'].allowedTools).toEqual(exposure.map((n) => `mcp__breeze__${n}`));
    expect(CAPTURE_SURFACES['agent-full'].includePartialMessages).toBe(false);
  });

  it.each([
    ['agent-full-remediation', 'full', REPRESENTATIVE_REMEDIATION_ALLOWLIST],
    ['agent-analysis', 'analysis', []],
  ] as const)('%s mirrors runLoop\'s own exposure, turn cap and outcome tools', (id, profile, allowlist) => {
    const surface = CAPTURE_SURFACES[id];
    const { exposedNames, onlyTools } = resolveRunToolExposure({ profile }, [...allowlist]);
    const declared = new Set(listChatSurfaceToolNames());
    expect(surface.agentProfile).toBe(profile);
    expect(surface.allowedTools).toEqual([...new Set(exposedNames)]);
    expect([...surface.onlyTools!].sort()).toEqual([...onlyTools!].filter((n) => declared.has(n)).sort());
    expect(surface.turnBudget).toBe(resolveRunProfileLimits({ profile }, AI_AGENT_LIMIT_DEFAULTS).maxTurnsPerRun);
    expect(surface.includePartialMessages).toBe(false);
  });

  it('agent-full-remediation is the full floor plus the allowlist\'s mutating-only tools; analysis carries its outcome tool', () => {
    const remediation = CAPTURE_SURFACES['agent-full-remediation'];
    expect(remediation.turnBudget).toBe(AI_AGENT_LIMIT_DEFAULTS.maxTurnsPerRun);
    expect(remediation.outcomeTools).toEqual([]);
    for (const name of declaredFullRunToolExposure([])) expect(remediation.allowedTools).toContain(`mcp__breeze__${name}`);
    expect(remediation.onlyTools!.has('disk_cleanup')).toBe(true);
    const analysis = CAPTURE_SURFACES['agent-analysis'];
    expect(analysis.turnBudget).toBe(AI_AGENT_LIMIT_DEFAULTS.analysisMaxTurnsPerRun);
    expect(analysis.outcomeTools).toEqual(['submit_analysis']);
    expect(analysis.allowedTools).toContain(OUTCOME_MCP_TOOL_NAMES.submit_analysis);
    expect([...analysis.onlyTools!].sort()).toEqual([...ANALYSIS_TOOL_ALLOWLIST].sort());
  });

  it('helper levels register only their own tools (A-W04 onlyTools; basic = 10 tools)', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      const s = CAPTURE_SURFACES[`helper-${level}`];
      expect(s.allowedTools).toEqual(getHelperAllowedMcpToolNames(level));
      expect([...s.onlyTools!].sort()).toEqual(getHelperAllowedTools(level).sort());
    }
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toHaveLength(10);
  });

  it('script builder uses its own server', () => {
    expect(CAPTURE_SURFACES['script-builder'].server).toBe('script_builder');
    expect(CAPTURE_SURFACES['script-builder'].allowedTools).toEqual(SCRIPT_BUILDER_MCP_TOOL_NAMES);
  });

  it('every surface records where its values came from', () => {
    for (const s of Object.values(CAPTURE_SURFACES)) expect(s.source).toMatch(/\.ts:\d+/);
  });

  it('every allowedTools entry is namespaced under mcp__<mcpServerName>__', () => {
    for (const s of Object.values(CAPTURE_SURFACES)) {
      for (const name of s.allowedTools) {
        expect(name.startsWith(`mcp__${s.mcpServerName}__`), `${s.id}: ${name}`).toBe(true);
      }
    }
  });
});
