import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQueueKeyboard } from './useQueueKeyboard';
import { QUEUE_SHORTCUTS } from './queueShortcuts';
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
    onToggleBulk: vi.fn(),
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

  it('x toggles the active ticket into the bulk selection', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('x');
    expect(handlers.onToggleBulk).toHaveBeenCalledTimes(1);
  });

  // The `?` cheat sheet is generated from QUEUE_SHORTCUTS; every key it
  // advertises must reach a handler, so the card can never list a dead key.
  it.each(QUEUE_SHORTCUTS.flatMap((s) => s.keys.map((key) => [s.action, key] as const)))(
    'the advertised %s key "%s" dispatches',
    (_action, key) => {
      renderHook(() => useQueueKeyboard(handlers));
      press(key);
      const fired = Object.entries(handlers).filter(([name, h]) => name !== 'onEscape' && h.mock.calls.length > 0);
      expect(fired).toHaveLength(1);
    }
  );

  // Enter is a button's (and link's) own activation key. The page-level
  // "open full page" binding used to swallow it everywhere (preventDefault on
  // keydown cancels the click), so no button on the tickets page could be
  // pressed with Enter.
  it('leaves Enter to a focused button, link or radio', () => {
    renderHook(() => useQueueKeyboard(handlers));
    for (const make of [
      () => document.createElement('button'),
      () => Object.assign(document.createElement('a'), { href: '/x' }),
      () => { const el = document.createElement('div'); el.setAttribute('role', 'radio'); el.tabIndex = 0; return el; },
    ]) {
      const el = make();
      document.body.appendChild(el);
      el.focus();
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('still opens on Enter from a queue row', () => {
    renderHook(() => useQueueKeyboard(handlers));
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.tabIndex = 0;
    document.body.appendChild(row);
    row.focus();
    press('Enter', row);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });

  it('leaves arrow keys to a radio group or tab list that owns them', () => {
    renderHook(() => useQueueKeyboard(handlers));
    for (const role of ['radiogroup', 'tablist', 'menu']) {
      const group = document.createElement('div');
      group.setAttribute('role', role);
      const item = document.createElement('button');
      group.appendChild(item);
      document.body.appendChild(group);
      item.focus();
      press('ArrowDown', item);
      press('ArrowUp', item);
    }
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('is suspended while a dirty form is registered', () => {
    renderHook(() => useQueueKeyboard(handlers));
    useUiStore.setState({ dirtyFormCount: 1 });
    press('a');
    expect(handlers.onAssignMe).not.toHaveBeenCalled();
  });
});
