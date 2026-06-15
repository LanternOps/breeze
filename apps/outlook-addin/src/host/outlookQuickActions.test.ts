import { describe, expect, it } from 'vitest';
import { outlookQuickActions } from './outlookQuickActions';
import { outlookHostAdapter } from './outlook';
import type { QuickAction } from '@breeze/office-addin-core';

function ids(actions: QuickAction[]): string[] {
  return actions.map((a) => a.id);
}

describe('outlookQuickActions', () => {
  it('returns the mail-flavored chips (not the spreadsheet fallback)', () => {
    const actions = outlookQuickActions(undefined);
    expect(ids(actions)).toEqual(['summarize-email', 'draft-reply', 'extract-action-items']);
    expect(ids(actions)).not.toContain('summarize-sheet');
  });

  it('every chip carries a non-empty natural-language prompt', () => {
    for (const a of outlookQuickActions(undefined)) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.prompt.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic regardless of captured context', () => {
    const withCtx = outlookQuickActions({ kind: 'selection', text: 'an email body' });
    const without = outlookQuickActions(undefined);
    expect(ids(withCtx)).toEqual(ids(without));
  });

  it('is wired onto the Outlook adapter as host.quickActions', () => {
    expect(outlookHostAdapter.quickActions).toBe(outlookQuickActions);
  });
});
