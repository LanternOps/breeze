import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQueueKeyboard } from './useQueueKeyboard';

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('useQueueKeyboard', () => {
  const handlers = {
    onMove: vi.fn(),
    onOpen: vi.fn(),
    onAssignMe: vi.fn(),
    onFocusReply: vi.fn(),
    onFocusInternal: vi.fn(),
    onResolve: vi.fn(),
    onEscape: vi.fn()
  };

  beforeEach(() => Object.values(handlers).forEach((h) => h.mockClear()));
  afterEach(() => { document.body.innerHTML = ''; });

  it('j/k move selection', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('j');
    expect(handlers.onMove).toHaveBeenCalledWith(1);
    press('k');
    expect(handlers.onMove).toHaveBeenCalledWith(-1);
  });

  it('maps a/r/n/e/Escape/Enter', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('a'); expect(handlers.onAssignMe).toHaveBeenCalled();
    press('r'); expect(handlers.onFocusReply).toHaveBeenCalled();
    press('n'); expect(handlers.onFocusInternal).toHaveBeenCalled();
    press('e'); expect(handlers.onResolve).toHaveBeenCalled();
    press('Escape'); expect(handlers.onEscape).toHaveBeenCalled();
    press('Enter'); expect(handlers.onOpen).toHaveBeenCalled();
  });

  it('is suspended while an input is focused', () => {
    renderHook(() => useQueueKeyboard(handlers));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('ignores modified keys (Cmd+R etc.)', () => {
    renderHook(() => useQueueKeyboard(handlers));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true }));
    expect(handlers.onFocusReply).not.toHaveBeenCalled();
  });
});
