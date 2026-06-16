/**
 * tool_request router (spec §5 protocol step 2):
 *   non-mutating → execute via Office.js, POST the result immediately.
 *   mutating     → park in the approval queue ONLY (Task 8's ApprovalStore
 *                  executes on Apply / posts 'rejected' on Reject).
 * executeTool never throws — executor failures become { status: 'error' }
 * results so the model can react (the server's 60s read timeout is the
 * backstop, not the happy path).
 */
import type { ToolExecutor, ClientAiStreamEvent, ToolResultBody } from '@breeze/office-addin-core';
import { getWorkbookOverview } from './getWorkbookOverview';
import { readSelection } from './readSelection';
import { readRange } from './readRange';
import { readCellDetails } from './readCellDetails';
import { writeRange } from './writeRange';
import { insertFormula } from './insertFormula';
import { createSheet } from './createSheet';
import { formatRange } from './formatRange';
import { createTable } from './createTable';
import { createPivotTable } from './createPivotTable';
import { createChart } from './createChart';
import { searchWorkbook } from './searchWorkbook';
import { clearRange } from './clearRange';
import { sortRange } from './sortRange';

export type { ToolExecutor };

export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  get_workbook_overview: getWorkbookOverview,
  read_selection: readSelection,
  read_range: readRange,
  read_cell_details: readCellDetails,
  write_range: writeRange,
  insert_formula: insertFormula,
  create_sheet: createSheet,
  format_range: formatRange,
  create_table: createTable,
  create_pivot_table: createPivotTable,
  create_chart: createChart,
  search_workbook: searchWorkbook,
  clear_range: clearRange,
  sort_range: sortRange,
};

export const MUTATING_TOOLS = new Set([
  'write_range',
  'insert_formula',
  'create_sheet',
  'format_range',
  'create_table',
  'create_pivot_table',
  'create_chart',
  'clear_range',
  'sort_range',
]);

export type ToolRequest = Extract<ClientAiStreamEvent, { type: 'tool_request' }>;

export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  executors: Record<string, ToolExecutor> = TOOL_EXECUTORS,
): Promise<{ status: 'success' | 'error'; output: unknown }> {
  const executor = executors[toolName];
  if (!executor) return { status: 'error', output: { error: `Unknown tool: ${toolName}` } };
  try {
    return { status: 'success', output: await executor(input) };
  } catch (err) {
    return { status: 'error', output: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export type DispatcherDeps = {
  postToolResult: (result: ToolResultBody) => Promise<void>;
  enqueueApproval: (request: ToolRequest) => void | Promise<void>;
  /** Host tool layer; defaults to the Excel dispatcher constants. */
  executors?: Record<string, ToolExecutor>;
  mutatingTools?: ReadonlySet<string>;
};

export async function dispatchToolRequest(request: ToolRequest, deps: DispatcherDeps): Promise<void> {
  const mutatingTools = deps.mutatingTools ?? MUTATING_TOOLS;
  // Defense-in-depth: the server flag is OR-ed with the local set so a server
  // bug can never auto-execute a write.
  const mutating = request.mutating || mutatingTools.has(request.toolName);
  if (mutating) {
    await deps.enqueueApproval(request);
    return;
  }
  const { status, output } = await executeTool(request.toolName, request.input, deps.executors);
  await deps.postToolResult({ toolUseId: request.toolUseId, status, output });
}
