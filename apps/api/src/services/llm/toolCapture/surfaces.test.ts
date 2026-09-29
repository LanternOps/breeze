import { describe, expect, it } from 'vitest';
import { BREEZE_MCP_TOOL_NAMES, listChatSurfaceToolNames } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames, getHelperAllowedTools } from '../../helperToolFilter';
import { fullRunToolExposure } from '../../aiAgents/runLoop';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { CAPTURE_SURFACES } from './surfaces';

describe('CAPTURE_SURFACES derive from the surfaces\' own exports', () => {
  it('chat registers the whole TOOL_TIERS surface and is the only surface that may use tool search', () => {
    expect(CAPTURE_SURFACES.chat.allowedTools).toEqual(BREEZE_MCP_TOOL_NAMES);
    expect(CAPTURE_SURFACES.chat.onlyTools).toBeUndefined();
    expect(CAPTURE_SURFACES.chat.toolSearch).toBe(true);
    for (const s of Object.values(CAPTURE_SURFACES).filter((x) => x.id !== 'chat')) expect(s.toolSearch, s.id).toBe(false);
  });

  it('agent-full registers and allows the full-profile exposure of a read-only agent (empty allowlist)', () => {
    const exposure = fullRunToolExposure([]);
    const declared = new Set(listChatSurfaceToolNames());
    expect([...CAPTURE_SURFACES['agent-full'].onlyTools!].sort()).toEqual(exposure.filter((n) => declared.has(n)).sort());
    expect(CAPTURE_SURFACES['agent-full'].allowedTools).toEqual(exposure.map((n) => `mcp__breeze__${n}`));
    expect(CAPTURE_SURFACES['agent-full'].includePartialMessages).toBe(false);
  });

  it('helper levels register only their own tools (A-W04 onlyTools; basic = 9 tools)', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      const s = CAPTURE_SURFACES[`helper-${level}`];
      expect(s.allowedTools).toEqual(getHelperAllowedMcpToolNames(level));
      expect([...s.onlyTools!].sort()).toEqual(getHelperAllowedTools(level).sort());
    }
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toHaveLength(9);
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
