/**
 * PowerPoint empty-state quick-action chips. The host-neutral Excel grid
 * heuristic (`summarizeSelection` → `quickActionsFor`) is spreadsheet-flavored —
 * a deck has no cells, so it would collapse to the generic "Summarize this
 * sheet" fallback. This supplies a small, deck-appropriate set instead.
 *
 * Pure + deterministic: the captured `ctx` (linear `text`, or undefined when
 * capture failed) only steers labels, never throws. Wired onto the PowerPoint
 * adapter as `host.quickActions`; the pane uses it in place of the default.
 */
import type { QuickAction, WorkbookContext } from '@breeze/office-addin-core';

export function powerpointQuickActions(_ctx: WorkbookContext | undefined): QuickAction[] {
  return [
    {
      id: 'summarize-deck',
      label: 'Summarize this deck',
      prompt: 'Summarize this presentation and call out the key points per slide.',
    },
    {
      id: 'add-slide',
      label: 'Add a slide',
      prompt: 'Add a new slide. What should it cover?',
    },
    {
      id: 'tidy-text',
      label: 'Tidy up the selected text',
      prompt: 'Tidy up the selected text: tighten it, fix grammar, and make it presentation-ready.',
    },
  ];
}
