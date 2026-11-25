/**
 * #12429: the public MCP page documents the tool list modes by the names the
 * server actually answers to. apps/docs has no test runner, so the check lives
 * beside the code whose names it pins.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_LIST_MODES } from '@breeze/shared';
import { MCP_META_TOOL_NAMES } from './aiToolNames';
import { MCP_TOOL_LIST_HEADER, MCP_TOOL_LIST_META_KEY } from './mcpToolListMode';

const page = readFileSync(new URL('../../../docs/src/content/docs/features/mcp-server.mdx', import.meta.url), 'utf8');
const section = page.split(/^## /m).find((s) => s.startsWith('Tool list modes')) ?? '';

describe('mcp-server.mdx: Tool list modes', () => {
  it('has the section, and no longer calls it lab-only', () => {
    expect(section).not.toBe('');
    expect(page).not.toMatch(/lab[- ]only/i);
  });

  it('names both modes, all three meta-tools, the header, the _meta key and MCP_TOOL_LIST_DEFAULT', () => {
    for (const name of [...MCP_TOOL_LIST_MODES, ...MCP_META_TOOL_NAMES, MCP_TOOL_LIST_HEADER, MCP_TOOL_LIST_META_KEY, 'MCP_TOOL_LIST_DEFAULT']) {
      expect(section, name).toContain(name);
    }
  });

  it('names both refusals and where each credential is set', () => {
    for (const text of ['tool_list_mode_conflict', 'tool_list_mode_invalid', 'mcpToolListMode', 'Settings > API Keys', 'Account > Connected apps']) {
      expect(section, text).toContain(text);
    }
  });
});
