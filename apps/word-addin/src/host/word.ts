/**
 * The Word HostAdapter: the ONE place that binds the host-neutral core to the
 * `Word.*` object model. It wires up the Word modules — it does not reimplement
 * the core:
 *   - tools/dispatcher    → WORD_TOOL_EXECUTORS / WORD_MUTATING_TOOLS
 *   - chat/captureContext → captureWordContext / captureWordDocumentName
 *   - approval/buildPreview → buildWordPreview
 *   - host/wordSelection  → captureWordSelectionLabel / subscribeWordSelectionChanged
 *
 * Sibling of host/excel.ts (same shape); the pane (App/ChatPane) picks the
 * concrete adapter and injects it.
 */
import { buildWordPreview } from '../approval/buildPreview';
import { captureWordContext, captureWordDocumentName } from '../chat/captureContext';
import { WORD_MUTATING_TOOLS, WORD_TOOL_EXECUTORS } from '../tools/dispatcher';
import { captureWordSelectionLabel, subscribeWordSelectionChanged } from './wordSelection';
import { wordQuickActions } from './wordQuickActions';
import type { HostAdapter } from '@breeze/office-addin-core';

export const wordHostAdapter: HostAdapter = {
  captureContext: captureWordContext,
  captureName: captureWordDocumentName,
  toolExecutors: WORD_TOOL_EXECUTORS,
  mutatingTools: WORD_MUTATING_TOOLS,
  buildPreview: buildWordPreview,
  captureSelectionAddress: captureWordSelectionLabel,
  subscribeSelectionChanged: subscribeWordSelectionChanged,
  // Document-flavored composer vocabulary — the workbook defaults
  // ("Selection / Whole sheet / No workbook data", "Ask about this workbook…")
  // are wrong for Word. The neutral 'sheet' kind means "the whole document" here
  // (Word has no sheets), so it's labeled accordingly.
  contextOptions: [
    { value: 'selection', label: 'Selection' },
    { value: 'sheet', label: 'Whole document' },
    { value: 'none', label: '(none)' },
  ],
  composerPlaceholder: 'Ask anything about this document…',
  // Word's selection label is a free-text snippet, not an Excel range — show it
  // verbatim and never run the address parser on it.
  formatContextChip: (kind, selectionLabel) =>
    kind === 'none'
      ? '(none)'
      : kind === 'sheet'
        ? 'Whole document'
        : selectionLabel
          ? `Selection: ${selectionLabel}`
          : 'Selection',
  // Document-flavored quick actions (the spreadsheet grid heuristic is wrong for Word).
  quickActions: wordQuickActions,
};
