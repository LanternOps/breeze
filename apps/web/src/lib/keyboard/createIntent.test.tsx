import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CREATE_INTENT_STORAGE_KEY, CREATE_INTENT_TTL_MS, requestCreate, useCreateIntent } from './createIntent';

beforeEach(() => {
  sessionStorage.clear();
});

describe('createIntent', () => {
  it('opens the dialog on mount when the intent was left for this page, once', () => {
    requestCreate('quote');
    const open = vi.fn();
    renderHook(() => useCreateIntent('quote', open));
    expect(open).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CREATE_INTENT_STORAGE_KEY)).toBeNull();
    renderHook(() => useCreateIntent('quote', open));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves an intent for another page alone', () => {
    requestCreate('invoice');
    const open = vi.fn();
    renderHook(() => useCreateIntent('quote', open));
    expect(open).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CREATE_INTENT_STORAGE_KEY)).toContain('invoice');
  });

  it('opens immediately when the chord fires on the page that is already showing', () => {
    const open = vi.fn();
    renderHook(() => useCreateIntent('invoice', open));
    act(() => { requestCreate('invoice'); });
    expect(open).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CREATE_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('waits while disabled (permissions still loading), then opens once enabled', () => {
    requestCreate('quote');
    const open = vi.fn();
    const { rerender } = renderHook(({ enabled }) => useCreateIntent('quote', open, enabled), {
      initialProps: { enabled: false },
    });
    expect(open).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale intent', () => {
    vi.useFakeTimers();
    try {
      requestCreate('quote');
      vi.advanceTimersByTime(CREATE_INTENT_TTL_MS + 1);
      const open = vi.fn();
      renderHook(() => useCreateIntent('quote', open));
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
