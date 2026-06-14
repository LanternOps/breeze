/**
 * Word empty-state quick-action chips. The host-neutral Excel grid heuristic
 * (`summarizeSelection` → `quickActionsFor`) is spreadsheet-flavored — Word has
 * no cells, so it would collapse to the generic "Summarize this sheet" fallback.
 * This supplies a small, document-appropriate set instead.
 *
 * Pure + deterministic: the captured `ctx` (linear `text`, or undefined when
 * capture failed) only steers labels, never throws. Wired onto the Word adapter
 * as `host.quickActions`; the pane uses it in place of the default.
 */
import type { QuickAction, WorkbookContext } from '@breeze/office-addin-core';

export function wordQuickActions(_ctx: WorkbookContext | undefined): QuickAction[] {
  return [
    {
      id: 'summarize-document',
      label: 'Summarize this document',
      prompt: 'Summarize this document and call out the key points.',
    },
    {
      id: 'improve-writing',
      label: 'Improve the writing',
      prompt:
        'Improve the writing of the selected text: tighten it, fix grammar, and keep my meaning.',
    },
    {
      id: 'find-and-replace',
      label: 'Find and replace…',
      prompt: 'Help me find and replace text in this document. What should I look for?',
    },
  ];
}
