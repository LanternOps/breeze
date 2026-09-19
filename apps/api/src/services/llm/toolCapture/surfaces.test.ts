import { describe, expect, it } from 'vitest';
import { BREEZE_MCP_TOOL_NAMES } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames } from '../../helperToolFilter';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { CAPTURE_SURFACES } from './surfaces';

describe('CAPTURE_SURFACES derive from the surfaces\' own exports', () => {
  it('chat and agent-full expose the whole TOOL_TIERS surface with no registration subset', () => {
    expect(CAPTURE_SURFACES.chat.allowedTools).toEqual(BREEZE_MCP_TOOL_NAMES);
    expect(CAPTURE_SURFACES.chat.onlyTools).toBeUndefined();
    expect(CAPTURE_SURFACES['agent-full'].allowedTools).toEqual(BREEZE_MCP_TOOL_NAMES);
    expect(CAPTURE_SURFACES['agent-full'].onlyTools).toBeUndefined();
    expect(CAPTURE_SURFACES['agent-full'].includePartialMessages).toBe(false);
  });

  it('helper levels are permission allowlists over the full server (8/14/20 tools)', () => {
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toEqual(getHelperAllowedMcpToolNames('basic'));
    expect(CAPTURE_SURFACES['helper-standard'].allowedTools).toEqual(getHelperAllowedMcpToolNames('standard'));
    expect(CAPTURE_SURFACES['helper-extended'].allowedTools).toEqual(getHelperAllowedMcpToolNames('extended'));
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toHaveLength(8);
    expect(CAPTURE_SURFACES['helper-extended'].onlyTools).toBeUndefined();
  });

  it('script builder uses its own server', () => {
    expect(CAPTURE_SURFACES['script-builder'].server).toBe('script_builder');
    expect(CAPTURE_SURFACES['script-builder'].allowedTools).toEqual(SCRIPT_BUILDER_MCP_TOOL_NAMES);
  });

  it('every surface records where its values came from', () => {
    for (const s of Object.values(CAPTURE_SURFACES)) expect(s.source).toMatch(/\.ts:\d+/);
  });
});
