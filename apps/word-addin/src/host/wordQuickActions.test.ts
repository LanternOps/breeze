import { describe, expect, it } from 'vitest';
import { wordQuickActions } from './wordQuickActions';
import { wordHostAdapter } from './word';
import type { QuickAction } from '@breeze/office-addin-core';

function ids(actions: QuickAction[]): string[] {
  return actions.map((a) => a.id);
}

describe('wordQuickActions', () => {
  it('returns the document-flavored chips (not the spreadsheet fallback)', () => {
    const actions = wordQuickActions(undefined);
    expect(ids(actions)).toEqual(['summarize-document', 'improve-writing', 'find-and-replace']);
    // No spreadsheet-flavored chip leaks through.
    expect(ids(actions)).not.toContain('summarize-sheet');
  });

  it('every chip carries a non-empty natural-language prompt', () => {
    for (const a of wordQuickActions(undefined)) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.prompt.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic regardless of captured context', () => {
    const withCtx = wordQuickActions({ kind: 'selection', text: 'a paragraph' });
    const without = wordQuickActions(undefined);
    expect(ids(withCtx)).toEqual(ids(without));
  });

  it('is wired onto the Word adapter as host.quickActions', () => {
    expect(wordHostAdapter.quickActions).toBe(wordQuickActions);
  });
});
