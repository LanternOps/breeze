import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToMock = vi.hoisted(() => vi.fn(async () => 'soft' as const));
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

import { useAuthStore } from '../../stores/auth';
import { useUiStore } from '../../stores/uiStore';
import { resetTypingCadence } from './bareKeyGuard';
import { useQueueKeyboard } from '../../components/tickets/useQueueKeyboard';
import { useGlobalShortcuts } from './useGlobalShortcuts';

function press(key: string, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

function setPref(value: boolean | undefined) {
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@b.c', name: 'A', preferences: value === undefined ? {} : { characterKeyShortcuts: value } },
  } as never);
}

function queueHandlers() {
  return {
    onMove: vi.fn(), onOpen: vi.fn(), onAssignMe: vi.fn(), onFocusReply: vi.fn(),
    onFocusInternal: vi.fn(), onResolve: vi.fn(), onEscape: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  navigateToMock.mockClear();
  resetTypingCadence();
  useUiStore.setState({ isCommandPaletteOpen: false, isShortcutsHelpOpen: false, dirtyFormCount: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  useAuthStore.setState({ user: null } as never);
});

describe('characterKeyShortcuts preference (#9348, WCAG 2.1.4)', () => {
  it('off: no bare key reaches the global handler', () => {
    setPref(false);
    renderHook(() => useGlobalShortcuts());
    // Space the keys past the typing cadence so only the preference can block them.
    for (const k of ['c', 'c', 'g', 'd', '/', '[', '?']) {
      act(() => { vi.advanceTimersByTime(700); });
      press(k);
    }
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(useUiStore.getState().isCommandPaletteOpen).toBe(false);
    expect(useUiStore.getState().isShortcutsHelpOpen).toBe(false);
  });

  it('off: no chord indicator appears', () => {
    setPref(false);
    const { result } = renderHook(() => useGlobalShortcuts());
    press('g');
    expect(result.current).toBeNull();
  });

  it('off: queue single keys do nothing but Escape still works', () => {
    setPref(false);
    const h = queueHandlers();
    renderHook(() => useQueueKeyboard(h));
    for (const k of ['a', 'j', 'k', 'r', 'n', 'e', 'o', 'Enter', 'ArrowDown']) press(k);
    expect(h.onMove).not.toHaveBeenCalled();
    expect(h.onAssignMe).not.toHaveBeenCalled();
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(h.onResolve).not.toHaveBeenCalled();
    press('Escape');
    expect(h.onEscape).toHaveBeenCalledTimes(1);
  });

  it('off: modified keys (Cmd/Ctrl+K) are not swallowed by the hook', () => {
    setPref(false);
    renderHook(() => useGlobalShortcuts());
    const e = press('k', { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
  });

  it('on (explicit) and unset: behaviour unchanged', () => {
    for (const v of [true, undefined]) {
      setPref(v);
      resetTypingCadence();
      navigateToMock.mockClear();
      const { unmount } = renderHook(() => useGlobalShortcuts());
      press('g');
      act(() => { vi.advanceTimersByTime(700); });
      press('d');
      expect(navigateToMock).toHaveBeenCalledWith('/devices');
      act(() => { vi.advanceTimersByTime(700); });
      press('/');
      expect(useUiStore.getState().isCommandPaletteOpen).toBe(true);
      useUiStore.setState({ isCommandPaletteOpen: false });
      act(() => { vi.advanceTimersByTime(700); });
      press('?');
      expect(useUiStore.getState().isShortcutsHelpOpen).toBe(true);
      useUiStore.setState({ isShortcutsHelpOpen: false });
      unmount();
    }
  });

  it('on: queue keys work', () => {
    setPref(true);
    const h = queueHandlers();
    renderHook(() => useQueueKeyboard(h));
    press('j');
    expect(h.onMove).toHaveBeenCalledWith(1);
  });
});
