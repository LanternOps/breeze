/**
 * AI for Office — per-host client tool registries (spec §5).
 *
 * SEPARATE from the technician aiTools map / TOOL_TIERS. There is one registry
 * per Office host (CLIENT_TOOL_REGISTRIES[host]: excel/word/powerpoint/outlook);
 * a client session can only ever see the tools in its own host's registry (hard
 * allowlist; proven by clientAiTools.registry.test.ts). Tools do NOT execute on
 * the server: Office.js runs inside the host add-in, so the handler round-trips
 * through services/clientAiToolBridge.ts to that add-in.
 *
 * inputSchema entries are zod RAW SHAPES consumed by the Agent SDK's tool()
 * helper (the aiAgentSdkTools.ts:766+ convention). They describe/validate the
 * model's arguments; actual host semantics live in each add-in's Office.js
 * executor.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { db, withDbAccessContext, runOutsideDbContext } from '../db';
import { aiMessages, aiToolExecutions } from '../db/schema';
import type { ActiveSession } from './streamingSessionManager';
import { requestClientToolExecution } from './clientAiToolBridge';
import { applyDlp, type DlpRedactionEvent } from './clientAiDlp';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import { captureException } from './sentry';
import { type ClientHost } from './clientAiHosts';

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

export const EXCEL_CLIENT_TOOL_REGISTRY = {
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
  read_cell_details: {
    description:
      'Return the value, formula, number format, and any Excel error for a cell or range so you can explain it. Use this before explaining a formula or an error (e.g. #REF!, #VALUE!, #DIV/0!) — read the actual formula/error, never guess.',
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
      'Apply formatting to a range: bold/italic, font and fill colors (hex), number format string, font size, borders, text alignment/wrapping, and a simple conditional format (color scale or cell-value rule). Approval-gated.',
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
          borders: z
            .object({
              edges: z
                .array(z.enum(['top', 'bottom', 'left', 'right', 'all']))
                .max(5)
                .optional()
                .describe('Which edges to apply; "all" covers every outer + inner edge'),
              style: z.enum(['continuous', 'none']).optional().describe('Border line style (default continuous)'),
              color: z.string().max(20).optional().describe('Hex color, e.g. "#000000"'),
            })
            .strict()
            .optional(),
          alignment: z
            .object({
              horizontal: z.enum(['left', 'center', 'right']).optional(),
              vertical: z.enum(['top', 'middle', 'bottom']).optional(),
              wrapText: z.boolean().optional(),
            })
            .strict()
            .optional(),
          conditionalFormat: z
            .union([
              z.object({ type: z.literal('colorScale') }).strict(),
              z
                .object({
                  type: z.literal('cellValue'),
                  operator: z
                    .enum(['greaterThan', 'lessThan', 'equalTo', 'between', 'greaterThanOrEqual', 'lessThanOrEqual'])
                    .describe('Comparison operator for the rule'),
                  formula1: z.string().min(1).max(255).describe('Threshold/value, e.g. "100" or "=$B$1"'),
                  formula2: z.string().min(1).max(255).optional().describe('Second value for "between"'),
                  format: z
                    .object({
                      fontColor: z.string().max(20).optional(),
                      fillColor: z.string().max(20).optional(),
                      bold: z.boolean().optional(),
                    })
                    .strict()
                    .optional()
                    .describe('Formatting applied to matching cells'),
                })
                .strict(),
            ])
            .optional()
            .describe('Optional conditional formatting rule applied to the range'),
        })
        .strict(),
    },
  },
  clear_range: {
    description:
      'Clear a range — its contents (values/formulas), its formats, or both. Defaults to clearing contents only. Approval-gated.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      what: z
        .enum(['contents', 'formats', 'all'])
        .optional()
        .describe('What to clear: "contents" (values/formulas), "formats", or "all" (default "contents")'),
    },
  },
  sort_range: {
    description:
      'Sort the rows of a range by one or more columns. Each column is a 0-based offset within the range. Approval-gated.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      columns: z
        .array(
          z
            .object({
              column: z.number().int().min(0).max(16383).describe('0-based column offset within the range'),
              ascending: z.boolean().optional().describe('Sort ascending (default true)'),
            })
            .strict(),
        )
        .min(1)
        .max(64)
        .describe('Sort keys, applied in order (first is primary)'),
      hasHeaders: z.boolean().optional().describe('Treat the first row of the range as a header row'),
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
  create_pivot_table: {
    description:
      'Create a PivotTable summarizing a source range. Provide row fields, optional column fields, and value fields with an aggregation (sum/count/average/max/min). Requires Excel build support (ExcelApi 1.8); if unsupported the tool returns an error so you can fall back to a formula-based summary. Approval-gated.',
    mutating: true,
    inputSchema: {
      sourceAddress: addressSchema.describe('Range to summarize, including the header row, e.g. "A1:F500"'),
      destinationAddress: addressSchema.describe('Top-left anchor where the PivotTable is placed, e.g. "H1"'),
      sheetName: sheetNameSchema,
      rows: z
        .array(z.string().min(1).max(255))
        .min(1)
        .max(20)
        .describe('Header names to use as PivotTable row fields'),
      columns: z
        .array(z.string().min(1).max(255))
        .max(20)
        .optional()
        .describe('Header names to use as PivotTable column fields'),
      values: z
        .array(
          z
            .object({
              field: z.string().min(1).max(255),
              aggregation: z.enum(['sum', 'count', 'average', 'max', 'min']).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(20)
        .describe('Header names to aggregate, each with an optional aggregation (defaults to sum)'),
    },
  },
  create_chart: {
    description:
      'Create a chart from a source range. Choose a chartType (columnClustered/line/pie/bar/area), an optional title, and optional seriesBy (rows/columns/auto). Approval-gated.',
    mutating: true,
    inputSchema: {
      sourceAddress: addressSchema.describe('Range to plot, including headers, e.g. "A1:D12"'),
      sheetName: sheetNameSchema,
      chartType: z
        .enum(['columnClustered', 'line', 'pie', 'bar', 'area'])
        .describe('Chart type to create'),
      title: z.string().min(1).max(255).optional().describe('Chart title text'),
      seriesBy: z
        .enum(['rows', 'columns', 'auto'])
        .optional()
        .describe('Whether each series is a row or a column of the source ("auto" lets Excel decide)'),
    },
  },
} as const satisfies Record<string, ClientWorkbookTool>;

export type ClientToolName = keyof typeof EXCEL_CLIENT_TOOL_REGISTRY;

/**
 * AI for Office — Word baseline tool registry (Phase 4). Five tools mirroring
 * the add-in's Word HostAdapter executors. inputSchema keys are BYTE-IDENTICAL
 * to the client executor read keys (the cells-vs-values no-op bug, MEMORY.md):
 *   get_document_overview  {}                                     (read)
 *   read_selection         {}                                     (read)
 *   insert_text            text, location                         (mutating)
 *   format_text            format{bold?,italic?,underline?,fontColor?,fontSize?}
 *   find_replace           query, replace, matchCase?, matchWholeWord?
 */
export const WORD_CLIENT_TOOL_REGISTRY = {
  get_document_overview: {
    description:
      'Summarize the open Word document: paragraph and word counts plus the leading paragraphs of text. Call this first to orient yourself before reading or editing the document.',
    mutating: false,
    inputSchema: {},
  },
  read_selection: {
    description:
      "Read the user's current selection in the document: its text, broken into paragraphs. Use when the user refers to 'this', 'the selected text', or similar.",
    mutating: false,
    inputSchema: {},
  },
  insert_text: {
    description:
      'Insert text into the document at the current selection. The user sees a preview in the task pane and must click Apply before anything changes.',
    mutating: true,
    inputSchema: {
      text: z.string().min(1).max(100000).describe('The text to insert'),
      location: z
        .enum(['Replace', 'Start', 'End', 'Before', 'After'])
        .describe(
          'Where to insert relative to the selection: Replace the selection, or at its Start/End/Before/After',
        ),
    },
  },
  format_text: {
    description:
      'Apply character formatting to the current selection: bold/italic/underline, font color (hex), and font size. Approval-gated.',
    mutating: true,
    inputSchema: {
      format: z
        .object({
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          underline: z.boolean().optional(),
          fontColor: z.string().max(20).optional().describe('Hex color, e.g. "#1F4E79"'),
          fontSize: z.number().min(6).max(72).optional(),
        })
        .strict(),
    },
  },
  find_replace: {
    description:
      'Find every occurrence of a text query in the document and replace it. Approval-gated.',
    mutating: true,
    inputSchema: {
      query: z.string().min(1).max(255).describe('Text to search for'),
      replace: z.string().max(100000).describe('Replacement text (use an empty string to delete matches)'),
      matchCase: z.boolean().optional(),
      matchWholeWord: z.boolean().optional(),
    },
  },
} as const satisfies Record<string, ClientWorkbookTool>;

/**
 * AI for Office — PowerPoint baseline tool registry (Phase 5). Five tools
 * mirroring the add-in's PowerPoint HostAdapter executors. inputSchema keys are
 * BYTE-IDENTICAL to the client executor read keys (the cells-vs-values no-op
 * bug, MEMORY.md):
 *   get_presentation_overview {}                                  (read)
 *   read_selection            {}                                  (read)
 *   add_slide                 layoutName?                         (mutating)
 *   insert_text_box           text, slideIndex?                   (mutating)
 *   format_selection          format{bold?,italic?,underline?,fontColor?,fontSize?}
 *
 * NB: no find_replace — PowerPoint JS has no presentation-wide search primitive.
 * `format_selection`'s `format` object is byte-identical to Word's `format_text`.
 */
export const POWERPOINT_CLIENT_TOOL_REGISTRY = {
  get_presentation_overview: {
    description:
      'Summarize the open PowerPoint presentation: slide count and the title of each slide. Call this first to orient yourself before reading or editing the presentation.',
    mutating: false,
    inputSchema: {},
  },
  read_selection: {
    description:
      "Read the user's current selection in the presentation: the text of the selected shapes. Use when the user refers to 'this', 'the selected text', or similar.",
    mutating: false,
    inputSchema: {},
  },
  add_slide: {
    description:
      'Add a new slide to the presentation. Optionally choose a layout by name. To put text on the slide, follow up with insert_text_box. The user sees a preview in the task pane and must click Apply before anything changes.',
    mutating: true,
    inputSchema: {
      layoutName: z.string().min(1).max(255).optional().describe('Slide layout name; defaults to the first available layout'),
    },
  },
  insert_text_box: {
    description:
      'Insert a text box containing the given text onto a slide. Defaults to the selected slide when slideIndex is omitted. Approval-gated.',
    mutating: true,
    inputSchema: {
      text: z.string().min(1).max(100000).describe('The text to place in the new text box'),
      slideIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0-based index of the target slide; defaults to the selected slide'),
    },
  },
  format_selection: {
    description:
      'Apply character formatting to the selected shapes: bold/italic/underline, font color (hex), and font size. Approval-gated.',
    mutating: true,
    inputSchema: {
      format: z
        .object({
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          underline: z.boolean().optional(),
          fontColor: z.string().max(20).optional().describe('Hex color, e.g. "#1F4E79"'),
          fontSize: z.number().min(6).max(72).optional(),
        })
        .strict(),
    },
  },
} as const satisfies Record<string, ClientWorkbookTool>;

/**
 * AI for Office — Outlook baseline tool registry (Phase 6). Four tools mirroring
 * the add-in's Outlook (mail-model) HostAdapter executors. Outlook is the
 * outlier: no document/workbook surface — you work with the open email/thread
 * via Office.context.mailbox.item, so the verbs are summarize/extract/metadata
 * (read) and draft_reply (mutating). inputSchema keys are BYTE-IDENTICAL to the
 * client executor read keys (the cells-vs-values no-op bug, MEMORY.md):
 *   summarize_thread      {}                                       (read)
 *   extract_action_items  {}                                       (read)
 *   get_message_metadata  {}                                       (read)
 *   draft_reply           body, replyAll?                          (mutating)
 */
export const OUTLOOK_CLIENT_TOOL_REGISTRY = {
  summarize_thread: {
    description:
      'Read the body of the currently open email/thread so you can summarize it. Returns the message subject, sender, and the body broken into paragraphs. Call this before summarizing — never guess what the email says.',
    mutating: false,
    inputSchema: {},
  },
  extract_action_items: {
    description:
      'Read the body of the currently open email/thread so you can pull out action items, requests, deadlines, and questions. Returns the message subject and the body broken into paragraphs. Call this before listing action items — never guess what the email says.',
    mutating: false,
    inputSchema: {},
  },
  get_message_metadata: {
    description:
      'Return the metadata of the currently open email: subject, sender, recipients (to/cc), and date. Use this to answer who/when questions about the message without reading the full body.',
    mutating: false,
    inputSchema: {},
  },
  draft_reply: {
    description:
      'Draft a reply to the currently open email. The user sees a preview in the task pane and must click Apply before the reply form is opened or the draft is set. Set replyAll to reply to everyone on the thread instead of just the sender.',
    mutating: true,
    inputSchema: {
      body: z.string().min(1).max(100000).describe('The reply body text'),
      replyAll: z
        .boolean()
        .optional()
        .describe('Reply to everyone on the thread (To + Cc) instead of just the sender'),
    },
  },
} as const satisfies Record<string, ClientWorkbookTool>;

/** Per-host tool registries. Excel + Word + PowerPoint + Outlook are populated. */
export const CLIENT_TOOL_REGISTRIES: Record<ClientHost, Record<string, ClientWorkbookTool>> = {
  excel: EXCEL_CLIENT_TOOL_REGISTRY,
  word: WORD_CLIENT_TOOL_REGISTRY,
  powerpoint: POWERPOINT_CLIENT_TOOL_REGISTRY,
  outlook: OUTLOOK_CLIENT_TOOL_REGISTRY,
};

/** Back-compat alias for code/tests that only ever meant the Excel registry. */
export const CLIENT_TOOL_REGISTRY = EXCEL_CLIENT_TOOL_REGISTRY;

export function isClientHostSupported(host: ClientHost): boolean {
  return Object.keys(CLIENT_TOOL_REGISTRIES[host]).length > 0;
}

/** MCP server name === host string ⇒ SDK tool prefix mcp__<host>__<tool>
 *  (own namespace, disjoint from mcp__breeze__). */
export function clientMcpServerName(host: ClientHost): string {
  return host;
}
export function clientMcpToolPrefix(host: ClientHost): string {
  return `mcp__${clientMcpServerName(host)}__`;
}

export function clientToolNames(host: ClientHost): string[] {
  return Object.keys(CLIENT_TOOL_REGISTRIES[host]);
}
export function clientMutatingToolNames(host: ClientHost): string[] {
  return Object.entries(CLIENT_TOOL_REGISTRIES[host])
    .filter(([, def]) => def.mutating)
    .map(([name]) => name);
}
export function clientMcpToolNames(host: ClientHost): string[] {
  return clientToolNames(host).map((name) => `${clientMcpToolPrefix(host)}${name}`);
}

/** SDK allowlist for a session: 'readonly' strips mutating tools at session
 *  start (the handler also rejects them server-side as defense-in-depth). */
export function clientMcpToolNamesForWriteMode(
  host: ClientHost,
  writeMode: 'readwrite' | 'readonly',
): string[] {
  return Object.entries(CLIENT_TOOL_REGISTRIES[host])
    .filter(([, def]) => writeMode === 'readwrite' || !def.mutating)
    .map(([name]) => `${clientMcpToolPrefix(host)}${name}`);
}

// ============================================
// Handlers — the server side of the tool round-trip (spec §5)
// ============================================

export type ClientToolHandlerResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function textResult(text: string, isError = false): ClientToolHandlerResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

function extractErrorText(output: unknown): string {
  if (output && typeof output === 'object' && typeof (output as { error?: unknown }).error === 'string') {
    return (output as { error: string }).error;
  }
  if (typeof output === 'string' && output.length > 0) return output;
  return 'Tool execution failed in the add-in.';
}

/**
 * DLP chokepoint (b): every tool_result payload is scanned before the model
 * sees it (spec §6). Two passes:
 *  1. If the output carries a `cells` matrix (read_range/read_selection/
 *     search_workbook shapes), scan it cell-by-cell for cell-level redaction.
 *  2. The whole (post-pass-1) output is scanned as JSON text — catches
 *     addresses, found-value strings, error text etc. If a redaction breaks
 *     JSON syntax (e.g. a bare numeric value replaced by a token), the result
 *     degrades to { redacted: <text> } rather than leaking the original.
 * Pass 2 re-sees pass-1 tokens, which is safe: [REDACTED:*] re-scans to zero
 * findings (Plan 3 idempotency contract).
 */
export async function applyDlpToToolOutput(
  output: unknown,
  orgId: string,
  dlpConfig: unknown,
): Promise<{ blocked: string | null; output: unknown; redactions: DlpRedactionEvent[] }> {
  const redactions: DlpRedactionEvent[] = [];
  let working: unknown = output ?? null;

  if (working && typeof working === 'object' && Array.isArray((working as { cells?: unknown }).cells)) {
    const cells = (working as { cells: unknown[][] }).cells;
    const cellResult = await applyDlp({ cells, dlpConfig, orgId });
    if (cellResult.action === 'block') {
      return { blocked: cellResult.blockReason ?? 'dlp_blocked', output: null, redactions: cellResult.redactions };
    }
    redactions.push(...cellResult.redactions);
    working = { ...(working as Record<string, unknown>), cells: cellResult.cells };
  }

  const asText = JSON.stringify(working ?? null);
  const textResultDlp = await applyDlp({ text: asText, dlpConfig, orgId });
  if (textResultDlp.action === 'block') {
    return {
      blocked: textResultDlp.blockReason ?? 'dlp_blocked',
      output: null,
      redactions: [...redactions, ...textResultDlp.redactions],
    };
  }
  redactions.push(...textResultDlp.redactions);

  let finalOutput: unknown = working;
  if (textResultDlp.text !== undefined && textResultDlp.text !== asText) {
    try {
      finalOutput = JSON.parse(textResultDlp.text);
    } catch {
      finalOutput = { redacted: textResultDlp.text };
    }
  }

  return { blocked: null, output: finalOutput, redactions };
}

interface PersistParams {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  status: 'completed' | 'failed' | 'rejected';
  durationMs: number;
  errorMessage: string | null;
  redactions: DlpRedactionEvent[];
}

/** Persist the REDACTED tool result (spec §6 redact-before-log) + execution audit row. */
async function persistClientToolResult(session: ActiveSession, params: PersistParams): Promise<void> {
  try {
    await withDbAccessContext(
      { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
      async () => {
        await db.insert(aiMessages).values({
          sessionId: session.breezeSessionId,
          role: 'tool_result',
          toolName: params.toolName,
          toolUseId: params.toolUseId,
          toolOutput: (params.output ?? null) as Record<string, unknown>,
          contentBlocks:
            params.redactions.length > 0
              ? ([{ type: 'dlp_redactions', redactions: params.redactions }] as unknown as Record<string, unknown>[])
              : null,
        });
        await db.insert(aiToolExecutions).values({
          sessionId: session.breezeSessionId,
          toolName: params.toolName,
          toolInput: params.input,
          toolOutput: (params.output ?? null) as Record<string, unknown>,
          status: params.status,
          durationMs: params.durationMs,
          errorMessage: params.errorMessage,
          completedAt: new Date(),
        });
      },
    );
  } catch (err) {
    captureException(err);
    console.error(`[client-ai] Failed to persist tool result for ${params.toolName}:`, err);
  }
}

function auditClientTool(
  session: ActiveSession,
  action: 'ai.client_session.tool_execute' | 'ai.client_session.tool_reject',
  params: {
    toolUseId: string;
    toolName: string;
    result: 'success' | 'failure' | 'denied';
    details?: Record<string, unknown>;
  },
): void {
  // No Hono context in the SDK callback chain — rebuild a RequestLike from the
  // session's audit snapshot (streamingSessionManager AuditSnapshot +
  // requestLikeFromSnapshot, auditEvents.ts:18). Actor convention matches
  // Plan 1's exchange route: actorType 'user' + principalType 'portal_user'.
  writeAuditEvent(requestLikeFromSnapshot(session.auditSnapshot), {
    orgId: session.orgId,
    action,
    resourceType: 'ai_tool_execution',
    resourceId: params.toolUseId,
    actorType: 'user',
    actorId: session.auth.user.id,
    actorEmail: session.auth.user.email,
    result: params.result,
    details: {
      principalType: 'portal_user',
      sessionId: session.breezeSessionId,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      ...(params.details ?? {}),
    },
  });
}

export function makeClientToolHandler(
  host: ClientHost,
  toolName: string,
  getSession: () => ActiveSession,
) {
  const entry = CLIENT_TOOL_REGISTRIES[host][toolName];
  if (!entry) {
    throw new Error(`Unknown client tool '${toolName}' for host '${host}'`);
  }

  return async (args: Record<string, unknown>): Promise<ClientToolHandlerResult> => {
    // Escape any inherited AsyncLocalStorage DB context from the SDK callback
    // chain (the makeHandler precedent, aiAgentSdkTools.ts — stale-transaction hangs).
    return runOutsideDbContext(async () => {
      const session = getSession();
      // Correlate with the model's tool_use block id: the background processor
      // pushes ids on content_block_start (streamingSessionManager.ts:611) and
      // the technician path drains them in createSessionPostToolUse
      // (aiAgentSdk.ts:640). Client handlers bypass that callback, so drain here.
      const toolUseId = session.toolUseIdQueue.shift() ?? crypto.randomUUID();
      const startTime = Date.now();

      // Server-side write-mode enforcement (pinned contract): 'readonly'
      // strips mutating tools from the toolset at session start AND rejects
      // them here if invoked anyway (e.g. resumed SDK process).
      if (entry.mutating && session.clientWriteMode === 'readonly') {
        const error =
          'Workbook writes are disabled for this organization (read-only policy). Offer the change as formula text or step-by-step instructions instead.';
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'rejected', durationMs: 0, errorMessage: error, redactions: [],
        });
        auditClientTool(session, 'ai.client_session.tool_reject', {
          toolUseId, toolName, result: 'denied', details: { reason: 'readonly_policy' },
        });
        session.eventBus.publish({ type: 'tool_completed', toolUseId, toolName, status: 'rejected' });
        return textResult(JSON.stringify({ error }), true);
      }

      const result = await requestClientToolExecution(session, toolUseId, toolName, args, entry.mutating);
      const durationMs = Date.now() - startTime;

      if (result.status === 'rejected') {
        const error =
          'The user rejected this action in the task pane. Do not retry the same change — adjust your approach or ask what they would prefer.';
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'rejected', durationMs, errorMessage: error, redactions: [],
        });
        auditClientTool(session, 'ai.client_session.tool_reject', {
          toolUseId, toolName, result: 'denied', details: { reason: 'user_rejected' },
        });
        session.eventBus.publish({ type: 'tool_completed', toolUseId, toolName, status: 'rejected' });
        return textResult(JSON.stringify({ error }), true);
      }

      if (result.status !== 'success') {
        // 'error' (add-in reported failure) or 'timeout' (bridge timer fired)
        const error = extractErrorText(result.output);
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'failed', durationMs, errorMessage: error, redactions: [],
        });
        auditClientTool(session, 'ai.client_session.tool_execute', {
          toolUseId, toolName, result: 'failure', details: { reason: result.status, durationMs },
        });
        session.eventBus.publish({ type: 'tool_completed', toolUseId, toolName, status: result.status });
        return textResult(JSON.stringify({ error }), true);
      }

      // DLP chokepoint (b): scan before the model sees the payload (spec §6).
      const dlp = await applyDlpToToolOutput(result.output, session.orgId, session.clientDlpConfig ?? {});
      if (dlp.blocked) {
        const error = `Result blocked by your organization's data protection policy (${dlp.blocked}).`;
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'failed', durationMs, errorMessage: error, redactions: dlp.redactions,
        });
        auditClientTool(session, 'ai.client_session.tool_execute', {
          toolUseId, toolName, result: 'denied', details: { reason: 'dlp_blocked', blockReason: dlp.blocked },
        });
        session.eventBus.publish({
          type: 'tool_completed', toolUseId, toolName, status: 'error',
          blockReason: dlp.blocked, redactions: dlp.redactions,
        });
        return textResult(JSON.stringify({ error }), true);
      }

      await persistClientToolResult(session, {
        toolUseId, toolName, input: args, output: dlp.output,
        status: 'completed', durationMs, errorMessage: null, redactions: dlp.redactions,
      });
      auditClientTool(session, 'ai.client_session.tool_execute', {
        toolUseId, toolName, result: 'success',
        details: { durationMs, redactionCount: dlp.redactions.length },
      });
      session.eventBus.publish({
        type: 'tool_completed', toolUseId, toolName, status: 'success', redactions: dlp.redactions,
      });
      return textResult(typeof dlp.output === 'string' ? dlp.output : JSON.stringify(dlp.output ?? null));
    });
  };
}

/**
 * SDK MCP server for a client session — constructed ONLY from the host's own
 * registry, CLIENT_TOOL_REGISTRIES[host] (hard cross-host isolation;
 * registry.test.ts). Plugged into streamingSessionManager.getOrCreate via the
 * mcpServerFactory parameter (the scriptAi.ts:211-215 precedent).
 */
export function createClientWorkbookMcpServer(host: ClientHost, getSession: () => ActiveSession) {
  return createSdkMcpServer({
    name: clientMcpServerName(host),
    version: '1.0.0',
    tools: Object.entries(CLIENT_TOOL_REGISTRIES[host]).map(([name, def]) =>
      tool(name, def.description, def.inputSchema, makeClientToolHandler(host, name, getSession)),
    ),
  });
}
