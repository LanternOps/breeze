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

  it('MCP server name + prefix are host-keyed', () => {
    expect(clientMcpServerName('excel')).toBe('excel');
    expect(clientMcpToolPrefix('excel')).toBe('mcp__excel__');
    expect(clientMcpServerName('word')).toBe('word');
  });
});

const WORD_PINNED_NAMES = [
  'find_replace',
  'format_text',
  'get_document_overview',
  'insert_text',
  'read_selection',
];

const WORD_PINNED_MUTATING = ['find_replace', 'format_text', 'insert_text'];

describe('word', () => {
  it('contains exactly the 5 baseline Word tools', () => {
    expect(Object.keys(CLIENT_TOOL_REGISTRIES.word).sort()).toEqual(WORD_PINNED_NAMES);
    expect(clientToolNames('word').slice().sort()).toEqual(WORD_PINNED_NAMES);
  });

  it('flags exactly the 3 write tools as mutating', () => {
    const mutating = Object.entries(CLIENT_TOOL_REGISTRIES.word)
      .filter(([, def]) => def.mutating)
      .map(([name]) => name)
      .sort();
    expect(mutating).toEqual(WORD_PINNED_MUTATING);
  });

  it('is supported once the registry is populated', () => {
    expect(isClientHostSupported('word')).toBe(true);
  });

  it('every tool has a non-empty description and an inputSchema object', () => {
    for (const def of Object.values(CLIENT_TOOL_REGISTRIES.word)) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(typeof def.inputSchema).toBe('object');
    }
  });

  it('uses the mcp__word__ namespace for every tool', () => {
    expect(clientMcpServerName('word')).toBe('word');
    expect(clientMcpToolPrefix('word')).toBe('mcp__word__');
    const names = clientMcpToolNames('word');
    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(name.startsWith('mcp__word__')).toBe(true);
      expect(BREEZE_MCP_TOOL_NAMES).not.toContain(name);
    }
  });

  it('shares no tool name with the technician registries', () => {
    for (const name of clientToolNames('word')) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBeUndefined();
      expect(aiTools.has(name)).toBe(false);
    }
  });

  it('readwrite exposes all 5 tools; readonly strips the 3 mutating (length 2)', () => {
    expect(clientMcpToolNamesForWriteMode('word', 'readwrite')).toHaveLength(5);
    const readonly = clientMcpToolNamesForWriteMode('word', 'readonly');
    expect(readonly).toHaveLength(2);
    expect(readonly.sort()).toEqual([
      'mcp__word__get_document_overview',
      'mcp__word__read_selection',
    ]);
  });
});

const POWERPOINT_PINNED_NAMES = [
  'add_slide',
  'format_selection',
  'get_presentation_overview',
  'insert_text_box',
  'read_selection',
];

const POWERPOINT_PINNED_MUTATING = ['add_slide', 'format_selection', 'insert_text_box'];

describe('powerpoint', () => {
  it('contains exactly the 5 baseline PowerPoint tools', () => {
    expect(Object.keys(CLIENT_TOOL_REGISTRIES.powerpoint).sort()).toEqual(POWERPOINT_PINNED_NAMES);
    expect(clientToolNames('powerpoint').slice().sort()).toEqual(POWERPOINT_PINNED_NAMES);
  });

  it('flags exactly the 3 write tools as mutating', () => {
    const mutating = Object.entries(CLIENT_TOOL_REGISTRIES.powerpoint)
      .filter(([, def]) => def.mutating)
      .map(([name]) => name)
      .sort();
    expect(mutating).toEqual(POWERPOINT_PINNED_MUTATING);
  });

  it('is supported once the registry is populated', () => {
    expect(isClientHostSupported('powerpoint')).toBe(true);
  });

  it('every tool has a non-empty description and an inputSchema object', () => {
    for (const def of Object.values(CLIENT_TOOL_REGISTRIES.powerpoint)) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(typeof def.inputSchema).toBe('object');
    }
  });

  it('uses the mcp__powerpoint__ namespace for every tool', () => {
    expect(clientMcpServerName('powerpoint')).toBe('powerpoint');
    expect(clientMcpToolPrefix('powerpoint')).toBe('mcp__powerpoint__');
    const names = clientMcpToolNames('powerpoint');
    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(name.startsWith('mcp__powerpoint__')).toBe(true);
      expect(BREEZE_MCP_TOOL_NAMES).not.toContain(name);
    }
  });

  it('shares no tool name with the technician registries', () => {
    for (const name of clientToolNames('powerpoint')) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBeUndefined();
      expect(aiTools.has(name)).toBe(false);
    }
  });

  it('readwrite exposes all 5 tools; readonly strips the 3 mutating (length 2)', () => {
    expect(clientMcpToolNamesForWriteMode('powerpoint', 'readwrite')).toHaveLength(5);
    const readonly = clientMcpToolNamesForWriteMode('powerpoint', 'readonly');
    expect(readonly).toHaveLength(2);
    expect(readonly.sort()).toEqual([
      'mcp__powerpoint__get_presentation_overview',
      'mcp__powerpoint__read_selection',
    ]);
  });
});

const OUTLOOK_PINNED_NAMES = [
  'draft_reply',
  'extract_action_items',
  'get_message_metadata',
  'summarize_thread',
];

const OUTLOOK_PINNED_MUTATING = ['draft_reply'];

describe('outlook', () => {
  it('contains exactly the 4 baseline Outlook tools', () => {
    expect(Object.keys(CLIENT_TOOL_REGISTRIES.outlook).sort()).toEqual(OUTLOOK_PINNED_NAMES);
    expect(clientToolNames('outlook').slice().sort()).toEqual(OUTLOOK_PINNED_NAMES);
  });

  it('flags exactly the 1 write tool as mutating', () => {
    const mutating = Object.entries(CLIENT_TOOL_REGISTRIES.outlook)
      .filter(([, def]) => def.mutating)
      .map(([name]) => name)
      .sort();
    expect(mutating).toEqual(OUTLOOK_PINNED_MUTATING);
  });

  it('is supported once the registry is populated', () => {
    expect(isClientHostSupported('outlook')).toBe(true);
  });

  it('every tool has a non-empty description and an inputSchema object', () => {
    for (const def of Object.values(CLIENT_TOOL_REGISTRIES.outlook)) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(typeof def.inputSchema).toBe('object');
    }
  });

  it('uses the mcp__outlook__ namespace for every tool', () => {
    expect(clientMcpServerName('outlook')).toBe('outlook');
    expect(clientMcpToolPrefix('outlook')).toBe('mcp__outlook__');
    const names = clientMcpToolNames('outlook');
    expect(names).toHaveLength(4);
    for (const name of names) {
      expect(name.startsWith('mcp__outlook__')).toBe(true);
      expect(BREEZE_MCP_TOOL_NAMES).not.toContain(name);
    }
  });

  it('shares no tool name with the technician registries', () => {
    for (const name of clientToolNames('outlook')) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBeUndefined();
      expect(aiTools.has(name)).toBe(false);
    }
  });

  it('readwrite exposes all 4 tools; readonly strips the 1 mutating (length 3)', () => {
    expect(clientMcpToolNamesForWriteMode('outlook', 'readwrite')).toHaveLength(4);
    const readonly = clientMcpToolNamesForWriteMode('outlook', 'readonly');
    expect(readonly).toHaveLength(3);
    expect(readonly.sort()).toEqual([
      'mcp__outlook__extract_action_items',
      'mcp__outlook__get_message_metadata',
      'mcp__outlook__summarize_thread',
    ]);
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
