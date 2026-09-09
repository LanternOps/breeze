import { describe, expect, it } from 'vitest';

import { toastReducer, topOutletId, type ToastEntry } from './toastState';

describe('toastReducer', () => {
  it('shows a toast', () => {
    const next = toastReducer(null, {
      type: 'show',
      id: 1,
      request: { kind: 'success', text: 'Timer started' },
    });
    expect(next).toEqual({ id: 1, kind: 'success', text: 'Timer started', sourceId: null });
  });

  it('replaces the current toast rather than queueing behind it', () => {
    const first = toastReducer(null, {
      type: 'show',
      id: 1,
      request: { kind: 'success', text: 'Timer started' },
    });
    const second = toastReducer(first, {
      type: 'show',
      id: 2,
      request: { kind: 'error', text: 'Could not stop the timer' },
    });
    expect(second).toEqual({
      id: 2,
      kind: 'error',
      text: 'Could not stop the timer',
      sourceId: null,
    });
  });

  it('carries an optional sourceId for callers that scope a toast to a row', () => {
    const next = toastReducer(null, {
      type: 'show',
      id: 7,
      request: { kind: 'success', text: 'Approved · Restart host', sourceId: 'appr-1' },
    });
    expect(next?.sourceId).toBe('appr-1');
  });

  it('dismisses the current toast by id', () => {
    const current: ToastEntry = { id: 3, kind: 'success', text: 'Comment added', sourceId: null };
    expect(toastReducer(current, { type: 'dismiss', id: 3 })).toBeNull();
  });

  /**
   * The replaced toast's own hide timer keeps running (its `setTimeout` and its
   * exit-animation callback were both scheduled before the replacement landed).
   * Firing it must not take the NEW toast off screen — the whole point of
   * "second toast replaces the first" is that the second one still gets its
   * full hold.
   */
  it('ignores a dismiss from a toast that has already been replaced', () => {
    const current: ToastEntry = { id: 5, kind: 'error', text: 'Latest', sourceId: null };
    expect(toastReducer(current, { type: 'dismiss', id: 4 })).toBe(current);
  });

  it('ignores a dismiss when nothing is showing', () => {
    expect(toastReducer(null, { type: 'dismiss', id: 1 })).toBeNull();
  });
});

describe('topOutletId', () => {
  /**
   * Outlets are allocated in mount order and RN `Modal`s always paint above the
   * root host, so the highest-numbered mounted outlet is the one the user can
   * actually see. Rendering the toast in every outlet would paint it twice
   * (once behind a transparent sheet's scrim, once above it).
   */
  it('is null when no outlet is mounted', () => {
    expect(topOutletId([])).toBeNull();
  });

  it('picks the most recently mounted outlet', () => {
    expect(topOutletId([1, 4, 2])).toBe(4);
  });

  it('falls back to the root outlet once a modal outlet unmounts', () => {
    expect(topOutletId([1])).toBe(1);
  });
});
