import { describe, expect, it } from 'vitest';
import type { WispState } from './aiStore';
import { wispPageHoldsChat, wispPaneHandedOff } from './aiPageContext';

const wisp = (threadId: string) => ({ threadId }) as unknown as NonNullable<WispState>;

describe('the page composer holding the chat (/wisp hand-off)', () => {
  it('holds it only when the page claims the store\'s own Wisp thread', () => {
    expect(wispPageHoldsChat({ wisp: wisp('t-1'), wispPageThreadId: 't-1' })).toBe(true);
    expect(wispPageHoldsChat({ wisp: wisp('t-2'), wispPageThreadId: 't-1' })).toBe(false);
    expect(wispPageHoldsChat({ wisp: null, wispPageThreadId: 't-1' })).toBe(false);
    expect(wispPageHoldsChat({ wisp: wisp('t-1'), wispPageThreadId: null })).toBe(false);
  });

  it('the pane is handed off when the page holds the chat, unless it is showing History (a real pane)', () => {
    expect(wispPaneHandedOff({ wisp: wisp('t-1'), wispPageThreadId: 't-1', showHistory: false })).toBe(true);
    expect(wispPaneHandedOff({ wisp: wisp('t-1'), wispPageThreadId: 't-1', showHistory: true })).toBe(false);
    expect(wispPaneHandedOff({ wisp: wisp('t-2'), wispPageThreadId: 't-1', showHistory: false })).toBe(false);
  });
});
