import { describe, it, expect } from 'vitest';
import {
  CLIENT_TOOL_REGISTRIES,
  EXCEL_CLIENT_TOOL_REGISTRY,
  CLIENT_TOOL_REGISTRY, // back-compat alias === EXCEL_CLIENT_TOOL_REGISTRY
  clientMcpServerName,
  clientMcpToolPrefix,
  clientToolNames,
  clientMcpToolNames,
  clientMcpToolNamesForWriteMode,
  isClientHostSupported,
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
    expect(clientToolNames('excel').slice().sort()).toEqual(PINNED_NAMES);
  });

  it('flags exactly the 9 write tools as mutating', () => {
    const mutating = Object.entries(CLIENT_TOOL_REGISTRY)
      .filter(([, def]) => def.mutating)
      .map(([name]) => name)
      .sort();
    expect(mutating).toEqual(PINNED_MUTATING);
  });

  it('every tool has a non-empty description and an inputSchema object', () => {
    for (const def of Object.values(CLIENT_TOOL_REGISTRY)) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(typeof def.inputSchema).toBe('object');
    }
  });
});

describe('hard isolation from the technician registry (spec §5: allowlist, not tier filtering)', () => {
  it('shares no tool name with the technician TOOL_TIERS map', () => {
    for (const name of clientToolNames('excel')) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBeUndefined();
    }
  });

  it('shares no tool name with the technician aiTools execution registry', () => {
    for (const name of clientToolNames('excel')) {
      expect(aiTools.has(name)).toBe(false);
    }
  });

  it('uses its own MCP namespace — no overlap with BREEZE_MCP_TOOL_NAMES', () => {
    expect(clientMcpServerName('excel')).toBe('excel');
    expect(clientMcpToolPrefix('excel')).toBe('mcp__excel__');
    for (const mcpName of clientMcpToolNames('excel')) {
      expect(mcpName.startsWith('mcp__excel__')).toBe(true);
      expect(BREEZE_MCP_TOOL_NAMES).not.toContain(mcpName);
    }
    expect(clientMcpToolNames('excel')).toHaveLength(14);
  });
});

describe('host-keyed registry map', () => {
  it('keeps the Excel registry as the only populated host (14 tools / 9 mutating)', () => {
    expect(Object.keys(EXCEL_CLIENT_TOOL_REGISTRY)).toHaveLength(14);
    expect(Object.values(EXCEL_CLIENT_TOOL_REGISTRY).filter((t) => t.mutating)).toHaveLength(9);
    expect(CLIENT_TOOL_REGISTRY).toBe(EXCEL_CLIENT_TOOL_REGISTRY);
  });

  it('word/powerpoint/outlook registries are empty (unsupported until built)', () => {
    expect(Object.keys(CLIENT_TOOL_REGISTRIES.word)).toHaveLength(0);
    expect(isClientHostSupported('excel')).toBe(true);
    expect(isClientHostSupported('word')).toBe(false);
  });

  it('MCP server name + prefix are host-keyed', () => {
    expect(clientMcpServerName('excel')).toBe('excel');
    expect(clientMcpToolPrefix('excel')).toBe('mcp__excel__');
    expect(clientMcpServerName('word')).toBe('word');
  });
});

describe('clientMcpToolNamesForWriteMode', () => {
  it('readwrite exposes all 14 excel tools; readonly strips the 9 mutating', () => {
    expect(clientMcpToolNamesForWriteMode('excel', 'readwrite')).toHaveLength(14);
    expect(clientMcpToolNamesForWriteMode('excel', 'readonly')).toHaveLength(5);
    for (const n of clientMcpToolNames('excel')) expect(n.startsWith('mcp__excel__')).toBe(true);
  });

  it('readonly strips every mutating tool from the toolset', () => {
    const names = clientMcpToolNamesForWriteMode('excel', 'readonly');
    expect(names.sort()).toEqual([
      'mcp__excel__get_workbook_overview',
      'mcp__excel__read_cell_details',
      'mcp__excel__read_range',
      'mcp__excel__read_selection',
      'mcp__excel__search_workbook',
    ]);
  });
});
