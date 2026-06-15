import { describe, expect, it } from 'vitest';
import { powerpointQuickActions } from './powerpointQuickActions';
import { powerpointHostAdapter } from './powerpoint';
import type { QuickAction } from '@breeze/office-addin-core';

function ids(actions: QuickAction[]): string[] {
  return actions.map((a) => a.id);
}

describe('powerpointQuickActions', () => {
  it('returns the deck-flavored chips (not the spreadsheet fallback)', () => {
    const actions = powerpointQuickActions(undefined);
    expect(ids(actions)).toEqual(['summarize-deck', 'add-slide', 'tidy-text']);
    expect(ids(actions)).not.toContain('summarize-sheet');
  });

  it('every chip carries a non-empty natural-language prompt', () => {
    for (const a of powerpointQuickActions(undefined)) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.prompt.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic regardless of captured context', () => {
    const withCtx = powerpointQuickActions({ kind: 'selection', text: 'a slide note' });
    const without = powerpointQuickActions(undefined);
    expect(ids(withCtx)).toEqual(ids(without));
  });

  it('is wired onto the PowerPoint adapter as host.quickActions', () => {
    expect(powerpointHostAdapter.quickActions).toBe(powerpointQuickActions);
  });
});
