import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToMock = vi.hoisted(() => vi.fn(async () => 'soft' as const));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

import { useUiStore } from '../../stores/uiStore';
import { CHORD_TIMEOUT_MS, SIDEBAR_CYCLE_MODE_EVENT, useGlobalShortcuts } from './useGlobalShortcuts';
import { CREATE_SHORTCUTS, GO_TO_SHORTCUTS } from './goToShortcuts';
import { CREATE_INTENT_STORAGE_KEY } from './createIntent';

function press(key: string, init: Partial<KeyboardEventInit> & { target?: EventTarget } = {}) {
  const { target, ...rest } = init;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest });
  // Dispatch from the body so the event bubbles document → window, the same
  // path a real keypress takes past page-level `document` listeners.
  (target ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  navigateToMock.mockClear();
  useUiStore.setState({ isCommandPaletteOpen: false, isShortcutsHelpOpen: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGlobalShortcuts', () => {
  it('navigates on a g-then-key chord and consumes the second key', () => {
    renderHook(() => useGlobalShortcuts());
    press('g');
    const second = press('d');
    expect(navigateToMock).toHaveBeenCalledWith('/devices');
    expect(second.defaultPrevented).toBe(true);
  });

  it('covers every registered go-to target', () => {
    renderHook(() => useGlobalShortcuts());
    for (const s of GO_TO_SHORTCUTS) {
      press('g');
      press(s.key);
      expect(navigateToMock).toHaveBeenLastCalledWith(s.href);
    }
    expect(navigateToMock).toHaveBeenCalledTimes(GO_TO_SHORTCUTS.length);
  });

  it('forgets the chord prefix after the timeout', () => {
    renderHook(() => useGlobalShortcuts());
    press('g');
    act(() => { vi.advanceTimersByTime(CHORD_TIMEOUT_MS + 1); });
    press('d');
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('a second key that is not a target cancels the chord without side effects', () => {
    renderHook(() => useGlobalShortcuts());
    press('g');
    const stray = press('z');
    expect(stray.defaultPrevented).toBe(false);
    press('d');
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('ignores keys typed into editable elements', () => {
    renderHook(() => useGlobalShortcuts());
    const input = document.createElement('input');
    document.body.appendChild(input);
    press('g', { target: input });
    press('d', { target: input });
    press('/', { target: input });
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
    input.remove();
  });

  it('ignores contenteditable targets', () => {
    renderHook(() => useGlobalShortcuts());
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    press('/', { target: editor });
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
    editor.remove();
  });

  it('yields to a page handler that already consumed the key', () => {
    renderHook(() => useGlobalShortcuts());
    const consume = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', consume);
    press('/');
    press('?');
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(false);
    document.removeEventListener('keydown', consume);
  });

  it('ignores chords with a command/control/alt modifier', () => {
    renderHook(() => useGlobalShortcuts());
    press('g', { metaKey: true });
    press('d', { metaKey: true });
    press('g', { ctrlKey: true });
    press('d');
    expect(navigateToMock).not.toHaveBeenCalled();
    press('[', { altKey: true });
  });

  it('/ opens the command palette', () => {
    renderHook(() => useGlobalShortcuts());
    const e = press('/');
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it('? toggles the shortcuts help', () => {
    renderHook(() => useGlobalShortcuts());
    press('?', { shiftKey: true });
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(true);
    press('?', { shiftKey: true });
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(false);
  });

  it('[ asks the sidebar to cycle its mode', () => {
    renderHook(() => useGlobalShortcuts());
    const listener = vi.fn();
    window.addEventListener(SIDEBAR_CYCLE_MODE_EVENT, listener);
    press('[');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(SIDEBAR_CYCLE_MODE_EVENT, listener);
  });

  it('a pending chord claims its second key before a page-level window handler', () => {
    renderHook(() => useGlobalShortcuts());
    // Mirrors useQueueKeyboard: registered after the island, on window, single-key "a".
    let assigned = 0;
    const assignMe = (e: KeyboardEvent) => { if (e.key === 'a') { assigned++; e.preventDefault(); } };
    window.addEventListener('keydown', assignMe);
    press('g');
    press('a');
    expect(navigateToMock).toHaveBeenCalledWith('/alerts');
    expect(assigned).toBe(0);
    // With no chord pending the page handler sees "a" as usual.
    press('a');
    expect(assigned).toBe(1);
    expect(navigateToMock).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', assignMe);
  });

  it('a chord prefix consumed by a page handler never starts a chord', () => {
    renderHook(() => useGlobalShortcuts());
    const consumeG = (e: KeyboardEvent) => { if (e.key === 'g') e.preventDefault(); };
    document.addEventListener('keydown', consumeG);
    press('g');
    press('d');
    expect(navigateToMock).not.toHaveBeenCalled();
    document.removeEventListener('keydown', consumeG);
  });

  it('closes the shortcuts help when a chord navigates away', () => {
    renderHook(() => useGlobalShortcuts());
    useUiStore.setState({ isShortcutsHelpOpen: true });
    press('g');
    press('a');
    expect(navigateToMock).toHaveBeenCalledWith('/alerts');
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(false);
  });

  it('reaches the billing and service pages', () => {
    renderHook(() => useGlobalShortcuts());
    for (const [key, href] of [['t', '/tickets'], ['q', '/billing/quotes'], ['b', '/billing/invoices'], ['c', '/contracts'], ['j', '/jobs']]) {
      press('g');
      press(key);
      expect(navigateToMock).toHaveBeenLastCalledWith(href);
    }
  });

  it('c-then-key opens a create form directly when the page has its own route', () => {
    renderHook(() => useGlobalShortcuts());
    press('c');
    const second = press('t');
    expect(navigateToMock).toHaveBeenCalledWith('/tickets/new');
    expect(second.defaultPrevented).toBe(true);
    press('c');
    press('s');
    expect(navigateToMock).toHaveBeenLastCalledWith('/scripts/new');
  });

  it('c-then-key leaves a one-shot create intent for list pages that open a dialog', () => {
    sessionStorage.clear();
    renderHook(() => useGlobalShortcuts());
    press('c');
    press('q');
    expect(navigateToMock).toHaveBeenCalledWith('/billing/quotes');
    expect(sessionStorage.getItem(CREATE_INTENT_STORAGE_KEY)).toContain('quote');
  });

  it('on the list page already showing, c-then-key opens the dialog in place without a page swap', () => {
    sessionStorage.clear();
    window.history.pushState({}, '', '/billing/quotes#status=draft');
    const onIntent = vi.fn();
    window.addEventListener('breeze:create-intent', onIntent);
    try {
      renderHook(() => useGlobalShortcuts());
      press('c');
      press('q');
      expect(onIntent).toHaveBeenCalledTimes(1);
      expect(navigateToMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('breeze:create-intent', onIntent);
      window.history.pushState({}, '', '/');
    }
  });

  it('covers every registered create target', () => {
    renderHook(() => useGlobalShortcuts());
    for (const s of CREATE_SHORTCUTS) {
      press('c');
      press(s.key);
      expect(navigateToMock).toHaveBeenLastCalledWith(s.href);
    }
    expect(navigateToMock).toHaveBeenCalledTimes(CREATE_SHORTCUTS.length);
  });

  it('exposes the pending prefix for the on-screen indicator, and clears it', () => {
    const { result } = renderHook(() => useGlobalShortcuts());
    expect(result.current).toBeNull();
    act(() => { press('g'); });
    expect(result.current).toBe('g');
    act(() => { press('d'); });
    expect(result.current).toBeNull();
    act(() => { press('c'); });
    expect(result.current).toBe('c');
    act(() => { vi.advanceTimersByTime(CHORD_TIMEOUT_MS + 1); });
    expect(result.current).toBeNull();
    act(() => { press('g'); });
    act(() => { press('Escape'); });
    expect(result.current).toBeNull();
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useGlobalShortcuts());
    unmount();
    press('/');
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
  });
});
