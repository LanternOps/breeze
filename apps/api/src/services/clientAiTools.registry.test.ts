import { describe, it, expect } from 'vitest';
import {
  CLIENT_TOOL_REGISTRY,
  CLIENT_TOOL_NAMES,
  CLIENT_MCP_SERVER_NAME,
  CLIENT_MCP_TOOL_PREFIX,
  CLIENT_MCP_TOOL_NAMES,
  clientMcpToolNamesForWriteMode,
} from './clientAiTools';
import { TOOL_TIERS, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import { aiTools } from './aiTools';

const PINNED_NAMES = [
  'clear_range',
  'create_chart',
  'create_pivot_table',
  'create_sheet',
  'create_table',
  'format_range',
  'get_workbook_overview',
  'insert_formula',
  'read_cell_details',
  'read_range',
  'read_selection',
  'search_workbook',
  'sort_range',
  'write_range',
];

const PINNED_MUTATING = [
  'clear_range',
  'create_chart',
  'create_pivot_table',
  'create_sheet',
  'create_table',
  'format_range',
  'insert_formula',
  'sort_range',
  'write_range',
];

describe('CLIENT_TOOL_REGISTRY — pinned shape (Plans 3/4/5 depend on these names)', () => {
  it('contains exactly the 14 pinned workbook tools', () => {
    expect(Object.keys(CLIENT_TOOL_REGISTRY).sort()).toEqual(PINNED_NAMES);
    expect(CLIENT_TOOL_NAMES.slice().sort()).toEqual(PINNED_NAMES);
  });

  it('flags exactly the 9 write tools as mutating', () => {
    const mutating = CLIENT_TOOL_NAMES.filter((n) => CLIENT_TOOL_REGISTRY[n].mutating).sort();
    expect(mutating).toEqual(PINNED_MUTATING);
  });

  it('every tool has a non-empty description and an inputSchema object', () => {
    for (const name of CLIENT_TOOL_NAMES) {
      expect(CLIENT_TOOL_REGISTRY[name].description.length).toBeGreaterThan(20);
      expect(typeof CLIENT_TOOL_REGISTRY[name].inputSchema).toBe('object');
    }
  });
});

describe('hard isolation from the technician registry (spec §5: allowlist, not tier filtering)', () => {
  it('shares no tool name with the technician TOOL_TIERS map', () => {
    for (const name of CLIENT_TOOL_NAMES) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBeUndefined();
    }
  });

  it('shares no tool name with the technician aiTools execution registry', () => {
    for (const name of CLIENT_TOOL_NAMES) {
      expect(aiTools.has(name)).toBe(false);
    }
  });

  it('uses its own MCP namespace — no overlap with BREEZE_MCP_TOOL_NAMES', () => {
    expect(CLIENT_MCP_SERVER_NAME).toBe('excel');
    expect(CLIENT_MCP_TOOL_PREFIX).toBe('mcp__excel__');
    for (const mcpName of CLIENT_MCP_TOOL_NAMES) {
      expect(mcpName.startsWith('mcp__excel__')).toBe(true);
      expect(BREEZE_MCP_TOOL_NAMES).not.toContain(mcpName);
    }
    expect(CLIENT_MCP_TOOL_NAMES).toHaveLength(14);
  });
});

describe('clientMcpToolNamesForWriteMode', () => {
  it('readwrite exposes all 14 tools', () => {
    expect(clientMcpToolNamesForWriteMode('readwrite')).toHaveLength(14);
  });

  it('readonly strips every mutating tool from the toolset', () => {
    const names = clientMcpToolNamesForWriteMode('readonly');
    expect(names.sort()).toEqual([
      'mcp__excel__get_workbook_overview',
      'mcp__excel__read_cell_details',
      'mcp__excel__read_range',
      'mcp__excel__read_selection',
      'mcp__excel__search_workbook',
    ]);
  });
});
