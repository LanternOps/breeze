import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQueueKeyboard } from './useQueueKeyboard';
import { resetTypingCadence } from '@/lib/keyboard/bareKeyGuard';
import { useUiStore } from '@/stores/uiStore';

function press(key: string, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
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

  beforeEach(() => {
    Object.values(handlers).forEach((h) => h.mockClear());
    vi.useFakeTimers();
    resetTypingCadence();
    useUiStore.setState({ dirtyFormCount: 0 });
  });
  afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

  it('j/k move selection', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('j');
    expect(handlers.onMove).toHaveBeenCalledWith(1);
    press('k');
    expect(handlers.onMove).toHaveBeenCalledWith(-1);
  });

  it('maps a/r/n/e/Escape/Enter', () => {
    renderHook(() => useQueueKeyboard(handlers));
    const gap = () => vi.advanceTimersByTime(700);
    press('a'); expect(handlers.onAssignMe).toHaveBeenCalled(); gap();
    press('r'); expect(handlers.onFocusReply).toHaveBeenCalled(); gap();
    press('n'); expect(handlers.onFocusInternal).toHaveBeenCalled(); gap();
    press('e'); expect(handlers.onResolve).toHaveBeenCalled(); gap();
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

  it('a 50ms after another printable key does not assign; alone it does', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('x'); vi.advanceTimersByTime(50); press('a');
    expect(handlers.onAssignMe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700); press('a');
    expect(handlers.onAssignMe).toHaveBeenCalledTimes(1);
  });

  it('typing "need" does not resolve or open the composer', () => {
    renderHook(() => useQueueKeyboard(handlers));
    for (const k of ['n', 'e', 'e', 'd']) { press(k); vi.advanceTimersByTime(50); }
    expect(handlers.onFocusInternal).toHaveBeenCalledTimes(1); // the leading n is a lone key
    expect(handlers.onResolve).not.toHaveBeenCalled();
  });

  it('held j keeps moving the selection', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('j'); vi.advanceTimersByTime(50); press('j'); vi.advanceTimersByTime(50); press('j');
    expect(handlers.onMove).toHaveBeenCalledTimes(3);
  });

  it('is suspended while a role=textbox element is focused', () => {
    renderHook(() => useQueueKeyboard(handlers));
    const el = document.createElement('div');
    el.setAttribute('role', 'textbox');
    el.tabIndex = 0;
    document.body.appendChild(el);
    el.focus();
    press('a', el);
    expect(handlers.onAssignMe).not.toHaveBeenCalled();
  });

  it('is suspended while a dirty form is registered', () => {
    renderHook(() => useQueueKeyboard(handlers));
    useUiStore.setState({ dirtyFormCount: 1 });
    press('a');
    expect(handlers.onAssignMe).not.toHaveBeenCalled();
  });
});
