import { act, cleanup, render } from '@testing-library/react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => {
    cleanup();
    restore();
  });

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

  it('detaches the shared listener after the last unmount and reattaches on remount', () => {
    const adds = vi.spyOn(window, 'addEventListener');
    const removes = vi.spyOn(window, 'removeEventListener');
    const count = (spy: typeof adds) => spy.mock.calls.filter((c) => c[0] === 'hashchange').length;
    function Page() {
      useHashState<string>('a0', parseA);
      useHashState<string>('b0', parseB);
      return null;
    }
    const first = render(<Page />);
    expect(count(adds)).toBe(1); // two hooks, one listener
    first.unmount();
    expect(count(removes)).toBe(1);
    const second = render(<Page />);
    expect(count(adds)).toBe(2);
    second.unmount();
    expect(count(removes)).toBe(2);
  });

  it('a throwing parser does not starve other hooks', () => {
    let boom = false;
    const seen: string[] = [];
    function Page() {
      const [a] = useHashState<string>('a0', (h) => {
        if (boom) throw new Error('bad parse');
        return parseA(h);
      });
      const [b] = useHashState<string>('b0', parseB);
      seen.push(`${a}|${b}`);
      return null;
    }
    render(<Page />);
    boom = true;
    const deferred = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {});
    act(() => {
      window.location.hash = '#a=a1&b=b1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(deferred).toHaveBeenCalledTimes(1); // error surfaced, not swallowed
    deferred.mockRestore();
    expect(seen[seen.length - 1]).toBe('a0|b1');
  });
});
