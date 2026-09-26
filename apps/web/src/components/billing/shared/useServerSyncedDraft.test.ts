import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useServerSyncedDraft } from './useServerSyncedDraft';

function setup(initial: string) {
  return renderHook(({ server }) => useServerSyncedDraft(server), { initialProps: { server: initial } });
}

describe('useServerSyncedDraft (#4296)', () => {
  it('replaces a dirty draft when the server brings a value we did not save', () => {
    const h = setup('A');
    act(() => h.result.current.edit('mine'));
    h.rerender({ server: 'theirs' });
    expect(h.result.current.draft).toBe('theirs');
    expect(h.result.current.dirty).toBe(false);
  });

  it('keeps text typed after a save when the refetch echoes that save', () => {
    const h = setup('A');
    act(() => h.result.current.edit('B'));
    act(() => h.result.current.markSaved('B'));
    expect(h.result.current.dirty).toBe(false);
    act(() => h.result.current.edit('B and more'));
    h.rerender({ server: 'B' });
    expect(h.result.current.draft).toBe('B and more');
    expect(h.result.current.dirty).toBe(true);
  });

  it('adopts the normalised server string for an echo when nothing was typed since', () => {
    const h = setup('A');
    act(() => h.result.current.edit('  B  '));
    act(() => h.result.current.markSaved('B'));
    h.rerender({ server: 'B' });
    expect(h.result.current.draft).toBe('B');
    expect(h.result.current.dirty).toBe(false);
  });

  it('does not flash back to an older echo while a newer save is still outstanding', () => {
    const h = setup('A');
    act(() => h.result.current.edit('B'));
    act(() => h.result.current.markSaved('B'));
    act(() => h.result.current.edit('C'));
    act(() => h.result.current.markSaved('C'));
    // First refetch lands carrying the first save.
    h.rerender({ server: 'B' });
    expect(h.result.current.draft).toBe('C');
    // Second refetch carries the second.
    h.rerender({ server: 'C' });
    expect(h.result.current.draft).toBe('C');
    // Echoes consumed: a later foreign change still wins.
    act(() => h.result.current.edit('C2'));
    h.rerender({ server: 'X' });
    expect(h.result.current.draft).toBe('X');
    expect(h.result.current.dirty).toBe(false);
  });

  it('does not record an echo for a save that leaves the server value unchanged', () => {
    const h = setup('A');
    act(() => h.result.current.edit('A'));
    act(() => h.result.current.markSaved('A'));
    // Someone else later changes it away and back to 'A' while we are typing:
    // that is a foreign change, not our echo, so it replaces the draft.
    h.rerender({ server: 'Z' });
    act(() => h.result.current.edit('typing'));
    h.rerender({ server: 'A' });
    expect(h.result.current.draft).toBe('A');
  });

  it('treats a null → "" normalised round-trip as no change', () => {
    const h = setup('');
    act(() => h.result.current.edit('draft'));
    h.rerender({ server: '' });
    expect(h.result.current.draft).toBe('draft');
    expect(h.result.current.dirty).toBe(true);
  });
});
