/**
 * The Outlook HostAdapter: the ONE place that binds the host-neutral core to the
 * `Office.context.mailbox` surface. It wires up the Outlook modules — it does not
 * reimplement the core:
 *   - tools/dispatcher      → OUTLOOK_TOOL_EXECUTORS / OUTLOOK_MUTATING_TOOLS
 *   - chat/captureContext   → captureOutlookContext / captureOutlookSubject
 *   - approval/buildPreview → buildOutlookPreview
 *   - host/outlookSelection → captureOutlookSelectionLabel / subscribeOutlookItemChanged
 *
 * Sibling of host/excel.ts and host/word.ts (same 7-member shape). Outlook is the
 * mail-model outlier, so it ALSO supplies the optional composer vocabulary
 * (contextOptions + composerPlaceholder) — the workbook-flavored defaults
 * ("Selection / Whole sheet / No workbook data", "Ask about this workbook…") are
 * wrong for mail. Excel/Word/PowerPoint leave these unset and inherit the
 * defaults.
 */
import { buildOutlookPreview } from '../approval/buildPreview';
import { captureOutlookContext, captureOutlookSubject } from '../chat/captureContext';
import { OUTLOOK_MUTATING_TOOLS, OUTLOOK_TOOL_EXECUTORS } from '../tools/dispatcher';
import { captureOutlookSelectionLabel, subscribeOutlookItemChanged } from './outlookSelection';
import type { HostAdapter } from '@breeze/office-addin-core';

export const outlookHostAdapter: HostAdapter = {
  captureContext: captureOutlookContext,
  captureName: captureOutlookSubject,
  toolExecutors: OUTLOOK_TOOL_EXECUTORS,
  mutatingTools: OUTLOOK_MUTATING_TOOLS,
  buildPreview: buildOutlookPreview,
  captureSelectionAddress: captureOutlookSelectionLabel,
  subscribeSelectionChanged: subscribeOutlookItemChanged,
  // Mail-flavored composer vocabulary (the workbook defaults are wrong for mail).
  contextOptions: [
    { value: 'selection', label: 'This email' },
    { value: 'none', label: 'No email data' },
  ],
  composerPlaceholder: 'Ask about this email…',
};
