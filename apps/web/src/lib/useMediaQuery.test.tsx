import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMediaQuery } from './useMediaQuery';

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
});

describe('useMediaQuery', () => {
  it('returns false when matchMedia is unavailable', () => {
    // @ts-expect-error simulate an environment without matchMedia
    window.matchMedia = undefined;
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);
  });

  it('reflects matches and follows change events', () => {
    let listener: (e: { matches: boolean }) => void = () => {};
    const addEventListener = vi.fn((_: string, fn: typeof listener) => {
      listener = fn;
    });
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener,
      removeEventListener,
    });
    const { result, unmount } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);

    act(() => listener({ matches: true }));
    expect(result.current).toBe(true);

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', listener);
  });
});
