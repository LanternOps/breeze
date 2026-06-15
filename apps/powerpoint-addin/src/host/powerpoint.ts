/**
 * The PowerPoint HostAdapter: the ONE place that binds the host-neutral core to
 * the `PowerPoint.*` object model. It wires up the PowerPoint modules — it does
 * not reimplement the core:
 *   - tools/dispatcher      → POWERPOINT_TOOL_EXECUTORS / POWERPOINT_MUTATING_TOOLS
 *   - chat/captureContext   → capturePptContext / capturePptName
 *   - approval/buildPreview → buildPptPreview
 *   - host/powerpointSelection → capturePptSelectionLabel / subscribePptSelectionChanged
 *
 * Sibling of host/word.ts and host/excel.ts (same shape); the pane (App/ChatPane)
 * picks the concrete adapter and injects it.
 */
import { buildPptPreview } from '../approval/buildPreview';
import { capturePptContext, capturePptName } from '../chat/captureContext';
import { POWERPOINT_MUTATING_TOOLS, POWERPOINT_TOOL_EXECUTORS } from '../tools/dispatcher';
import { capturePptSelectionLabel, subscribePptSelectionChanged } from './powerpointSelection';
import { powerpointQuickActions } from './powerpointQuickActions';
import type { HostAdapter } from '@breeze/office-addin-core';

export const powerpointHostAdapter: HostAdapter = {
  captureContext: capturePptContext,
  captureName: capturePptName,
  toolExecutors: POWERPOINT_TOOL_EXECUTORS,
  mutatingTools: POWERPOINT_MUTATING_TOOLS,
  buildPreview: buildPptPreview,
  captureSelectionAddress: capturePptSelectionLabel,
  subscribeSelectionChanged: subscribePptSelectionChanged,
  // Deck-flavored composer vocabulary — the workbook defaults
  // ("Selection / Whole sheet / No workbook data", "Ask about this workbook…")
  // are wrong for PowerPoint. The neutral 'sheet' kind means "the whole deck"
  // here (PowerPoint has no sheets).
  contextOptions: [
    { value: 'selection', label: 'Selection' },
    { value: 'sheet', label: 'Whole deck' },
    { value: 'none', label: '(none)' },
  ],
  composerPlaceholder: 'Ask anything about this deck…',
  // CRITICAL: PowerPoint's selection label is shape text or a "Slide N" locator,
  // NOT an Excel range — without this the core falls back to the Excel chip,
  // which runs `parseAddress` on the label and THROWS on "Slide 2" ("Unsupported
  // address"), crashing the pane to blank. Show the label verbatim instead.
  formatContextChip: (kind, selectionLabel) =>
    kind === 'none'
      ? '(none)'
      : kind === 'sheet'
        ? 'Whole deck'
        : selectionLabel
          ? `Selection: ${selectionLabel}`
          : 'Selection',
  // Deck-flavored quick actions (the spreadsheet grid heuristic is wrong for PowerPoint).
  quickActions: powerpointQuickActions,
};
