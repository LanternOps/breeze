/**
 * Outlook empty-state quick-action chips. The host-neutral Excel grid heuristic
 * (`summarizeSelection` → `quickActionsFor`) is spreadsheet-flavored — a mail
 * item has no cells, so it would collapse to the generic "Summarize this sheet"
 * fallback. This supplies a small, mail-appropriate set instead.
 *
 * Pure + deterministic: the captured `ctx` (the email body under `text`, or
 * undefined when capture failed) only steers labels, never throws. Wired onto
 * the Outlook adapter as `host.quickActions`; the pane uses it in place of the
 * default.
 */
import type { QuickAction, WorkbookContext } from '@breeze/office-addin-core';

export function outlookQuickActions(_ctx: WorkbookContext | undefined): QuickAction[] {
  return [
    {
      id: 'summarize-email',
      label: 'Summarize this email',
      prompt: 'Summarize this email and call out anything that needs a response.',
    },
    {
      id: 'draft-reply',
      label: 'Draft a reply',
      prompt: 'Draft a reply to this email.',
    },
    {
      id: 'extract-action-items',
      label: 'Extract action items',
      prompt: 'Extract the action items from this email as a checklist, with owners if mentioned.',
    },
  ];
}
