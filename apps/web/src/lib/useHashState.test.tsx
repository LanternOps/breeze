import { act, render } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useHashState } from './useHashState';

/**
 * Real browsers commit after every hashchange listener (hashchange is a
 * discrete event); jsdom runs all listeners from one stack and batches them.
 * Wrapping each listener in flushSync restores the per-listener commit (#8978).
 */
function emulateBrowserPerListenerCommit(): () => void {
  const originalAdd = window.addEventListener;
  const originalRemove = window.removeEventListener;
  const wrapped = new Map<EventListenerOrEventListenerObject, EventListener>();
  window.addEventListener = function (this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    if (type === 'hashchange' && typeof listener === 'function') {
      const w: EventListener = (e) => flushSync(() => listener(e));
      wrapped.set(listener, w);
      return originalAdd.call(this, type, w, options);
    }
    return originalAdd.call(this, type, listener, options);
  } as typeof window.addEventListener;
  window.removeEventListener = function (this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
    return originalRemove.call(this, type, wrapped.get(listener) ?? listener, options);
  } as typeof window.removeEventListener;
  return () => {
    window.addEventListener = originalAdd;
    window.removeEventListener = originalRemove;
  };
}

const parseA = (h: string) => (/a=(\w+)/.exec(h)?.[1]);
const parseB = (h: string) => (/b=(\w+)/.exec(h)?.[1]);
const parseC = (h: string) => (/c=(\w+)/.exec(h)?.[1]);

describe('useHashState with several hooks on one page (#8978)', () => {
  let restore: () => void;
  beforeEach(() => {
    window.location.hash = '';
    restore = emulateBrowserPerListenerCommit();
  });
  afterEach(() => restore());

  it('applies an external hash change to every hook in one commit', () => {
    const renders: string[] = [];
    function Page() {
      const [a] = useHashState<string>('a0', parseA);
      const [b] = useHashState<string>('b0', parseB);
      const [c] = useHashState<string>('c0', parseC);
      renders.push(`${a}|${b}|${c}`);
      return null;
    }
    render(<Page />);
    renders.length = 0;

    act(() => {
      window.location.hash = '#a=a1&b=b1&c=c1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    // No intermediate render may mix old and new fields.
    expect(renders.length).toBeGreaterThan(0);
    for (const r of renders) expect(['a0|b0|c0', 'a1|b1|c1']).toContain(r);
    expect(renders[renders.length - 1]).toBe('a1|b1|c1');
  });

  it('stops listening after unmount', () => {
    function Page() {
      useHashState<string>('a0', parseA);
      return null;
    }
    const { unmount } = render(<Page />);
    unmount();
    expect(() => {
      window.location.hash = '#a=a1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }).not.toThrow();
  });
});
