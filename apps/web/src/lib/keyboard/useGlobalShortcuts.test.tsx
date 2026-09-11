import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToMock = vi.hoisted(() => vi.fn(async () => 'soft' as const));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

import { useUiStore } from '../../stores/uiStore';
import { CHORD_TIMEOUT_MS, SIDEBAR_CYCLE_MODE_EVENT, useGlobalShortcuts } from './useGlobalShortcuts';
import { GO_TO_SHORTCUTS } from './goToShortcuts';

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

  it('closes the shortcuts help when a chord navigates away', () => {
    renderHook(() => useGlobalShortcuts());
    useUiStore.setState({ isShortcutsHelpOpen: true });
    press('g');
    press('a');
    expect(navigateToMock).toHaveBeenCalledWith('/alerts');
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(false);
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useGlobalShortcuts());
    unmount();
    press('/');
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
  });
});
