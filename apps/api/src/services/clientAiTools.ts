/**
 * AI for Office — client workbook tool registry (spec §5).
 *
 * A SEPARATE registry from the technician aiTools map / TOOL_TIERS — client
 * sessions can only ever see these 9 tools (hard allowlist; proven by
 * clientAiTools.registry.test.ts). Tools do NOT execute on the server:
 * Office.js only runs inside Excel, so the handler (Task 6) round-trips
 * through services/clientAiToolBridge.ts to the add-in.
 *
 * inputSchema entries are zod RAW SHAPES consumed by the Agent SDK's tool()
 * helper (the aiAgentSdkTools.ts:766+ convention). They describe/validate the
 * model's arguments; actual workbook semantics live in the add-in's Office.js
 * executor (Plan 5).
 */

import { z } from 'zod';

const addressSchema = z
  .string()
  .min(1)
  .max(100)
  .describe('A1-style address or range, e.g. "B2" or "B2:F40"');
const sheetNameSchema = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe('Sheet name; defaults to the active sheet when omitted');
const cellValueSchema = z.union([z.string().max(32767), z.number(), z.boolean(), z.null()]);
const cellMatrixSchema = z
  .array(z.array(cellValueSchema).min(1).max(500))
  .min(1)
  .max(5000)
  .describe('Row-major matrix of cell values matching the target range shape');

export interface ClientWorkbookTool {
  description: string;
  /** Mutating tools are approval-gated CLIENT-SIDE (preview card in the task
   *  pane) and stripped/rejected under policy writeMode 'readonly'. */
  mutating: boolean;
  inputSchema: Record<string, z.ZodTypeAny>;
}

export const CLIENT_TOOL_REGISTRY = {
  get_workbook_overview: {
    description:
      'List the sheets in the open workbook with their used ranges and first-row headers. Call this first to orient yourself before reading or writing data.',
    mutating: false,
    inputSchema: {},
  },
  read_selection: {
    description:
      "Read the user's current selection: its address, sheet, and cell values. Use when the user refers to 'this', 'the selected cells', or similar.",
    mutating: false,
    inputSchema: {},
  },
  read_range: {
    description:
      'Read the cell values of a specific range. Returns a row-major matrix. Read data before answering questions about it — never guess values.',
    mutating: false,
    inputSchema: { address: addressSchema, sheetName: sheetNameSchema },
  },
  write_range: {
    description:
      'Write a matrix of values into a range. The user sees a before/after preview in the task pane and must click Apply before anything changes.',
    mutating: true,
    inputSchema: { address: addressSchema, sheetName: sheetNameSchema, cells: cellMatrixSchema },
  },
  insert_formula: {
    description:
      'Insert an Excel formula (starting with "=") into a cell or fill it across a range. Approval-gated like all writes.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      formula: z.string().min(2).max(8192).startsWith('=').describe('Excel formula, e.g. "=SUM(B2:B40)"'),
    },
  },
  create_sheet: {
    description:
      'Create a new worksheet in the workbook. Sheet names are limited to 31 characters (Excel limit). Approval-gated.',
    mutating: true,
    inputSchema: { name: z.string().min(1).max(31).describe('New sheet name (max 31 chars)') },
  },
  format_range: {
    description:
      'Apply formatting to a range: bold/italic, font and fill colors (hex), number format string, font size. Approval-gated.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      format: z
        .object({
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          fontColor: z.string().max(20).optional().describe('Hex color, e.g. "#1F4E79"'),
          fillColor: z.string().max(20).optional().describe('Hex color, e.g. "#FFF2CC"'),
          numberFormat: z.string().max(100).optional().describe('Excel number format, e.g. "$#,##0.00"'),
          fontSize: z.number().min(6).max(72).optional(),
        })
        .strict(),
    },
  },
  create_table: {
    description:
      'Convert a range into an Excel table (sortable, filterable, banded rows). Approval-gated.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      hasHeaders: z.boolean().optional().describe('Whether the first row of the range is a header row'),
      tableName: z.string().min(1).max(255).optional(),
    },
  },
  search_workbook: {
    description:
      'Search the workbook (or one sheet) for a text value. Returns matching cell addresses and their values.',
    mutating: false,
    inputSchema: {
      query: z.string().min(1).max(255),
      sheetName: sheetNameSchema,
      matchCase: z.boolean().optional(),
    },
  },
} as const satisfies Record<string, ClientWorkbookTool>;

export type ClientToolName = keyof typeof CLIENT_TOOL_REGISTRY;

export const CLIENT_TOOL_NAMES = Object.keys(CLIENT_TOOL_REGISTRY) as ClientToolName[];

export const CLIENT_MUTATING_TOOL_NAMES = CLIENT_TOOL_NAMES.filter(
  (name) => CLIENT_TOOL_REGISTRY[name].mutating,
);

/** MCP server name → SDK tool prefix mcp__excel__<tool> (own namespace,
 *  disjoint from mcp__breeze__ — see registry.test.ts). */
export const CLIENT_MCP_SERVER_NAME = 'excel';
export const CLIENT_MCP_TOOL_PREFIX = `mcp__${CLIENT_MCP_SERVER_NAME}__`;

export const CLIENT_MCP_TOOL_NAMES = CLIENT_TOOL_NAMES.map(
  (name) => `${CLIENT_MCP_TOOL_PREFIX}${name}`,
);

/**
 * The SDK-level allowlist for a session: policy writeMode 'readonly' strips
 * mutating tools from the model's toolset at session start (pinned contract).
 * The handler additionally rejects mutating calls server-side (Task 6) in
 * case a resumed/stale SDK process still advertises them.
 */
export function clientMcpToolNamesForWriteMode(writeMode: 'readwrite' | 'readonly'): string[] {
  return CLIENT_TOOL_NAMES.filter(
    (name) => writeMode === 'readwrite' || !CLIENT_TOOL_REGISTRY[name].mutating,
  ).map((name) => `${CLIENT_MCP_TOOL_PREFIX}${name}`);
}
