/**
 * The Word tool layer, keyed by wire tool name (byte-identical to the server
 * registry keys). Reads auto-execute; the three mutating tools are
 * approval-gated by the core via WORD_MUTATING_TOOLS.
 */
import type { ToolExecutor } from '@breeze/office-addin-core';
import { getDocumentOverview } from './getDocumentOverview';
import { readSelection } from './readSelection';
import { insertText } from './insertText';
import { formatText } from './formatText';
import { findReplace } from './findReplace';

export const WORD_TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  get_document_overview: getDocumentOverview,
  read_selection: readSelection,
  insert_text: insertText,
  format_text: formatText,
  find_replace: findReplace,
};

export const WORD_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'insert_text',
  'format_text',
  'find_replace',
]);
