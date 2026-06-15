import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { MUTATING_TOOLS, TOOL_EXECUTORS, dispatchToolRequest, executeTool } from './dispatcher';
import type { ToolRequest } from './dispatcher';

function deps() {
  return { postToolResult: vi.fn(async () => undefined), enqueueApproval: vi.fn() };
}

function request(overrides: Partial<ToolRequest>): ToolRequest {
  return {
    type: 'tool_request',
    toolUseId: 'tu-1',
    toolName: 'read_range',
    input: {},
    mutating: false,
    ...overrides,
  };
}

describe('registry shape', () => {
  it('registers exactly the 14 spec §5 tools; 9 are mutating', () => {
    expect(Object.keys(TOOL_EXECUTORS).sort()).toEqual([
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
    ]);
    expect([...MUTATING_TOOLS].sort()).toEqual([
      'clear_range',
      'create_chart',
      'create_pivot_table',
      'create_sheet',
      'create_table',
      'format_range',
      'insert_formula',
      'sort_range',
      'write_range',
    ]);
  });
});

describe('dispatchToolRequest', () => {
  it('auto-executes non-mutating tools and posts the success result', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [['v']]);
    const d = deps();
    await dispatchToolRequest(request({ input: { address: 'A1' } }), d);
    expect(d.enqueueApproval).not.toHaveBeenCalled();
    expect(d.postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-1',
      status: 'success',
      output: { address: 'Sheet1!A1', rowCount: 1, columnCount: 1, cells: [['v']] },
    });
  });

  it('parks mutating tools in the approval queue WITHOUT executing or posting', async () => {
    const d = deps();
    const req = request({ toolName: 'write_range', mutating: true, input: { address: 'A1', values: [['x']] } });
    await dispatchToolRequest(req, d);
    expect(d.enqueueApproval).toHaveBeenCalledWith(req);
    expect(d.postToolResult).not.toHaveBeenCalled();
    expect(getOfficeMock().getValues('Sheet1', 'A1')).toEqual([['']]); // nothing written
  });

  it('treats a locally-known mutating tool as mutating even if the server flag lies', async () => {
    const d = deps();
    await dispatchToolRequest(
      request({ toolName: 'write_range', mutating: false, input: { address: 'A1', values: [['x']] } }),
      d,
    );
    expect(d.enqueueApproval).toHaveBeenCalledTimes(1);
    expect(d.postToolResult).not.toHaveBeenCalled();
  });

  it('posts status:error when the executor throws', async () => {
    const d = deps();
    await dispatchToolRequest(request({ input: { address: 'A1', sheetName: 'Nope' } }), d);
    expect(d.postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-1',
      status: 'error',
      output: { error: expect.stringContaining('No worksheet named "Nope"') },
    });
  });

  it('posts status:error for an unknown tool', async () => {
    const d = deps();
    await dispatchToolRequest(request({ toolName: 'launch_missiles' }), d);
    expect(d.postToolResult).toHaveBeenCalledWith({
      toolUseId: 'tu-1',
      status: 'error',
      output: { error: 'Unknown tool: launch_missiles' },
    });
  });
});

describe('executeTool', () => {
  it('never throws — failures come back as { status: "error" }', async () => {
    await expect(executeTool('read_range', {})).resolves.toMatchObject({ status: 'error' });
  });
});
