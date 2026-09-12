import { describe, expect, it } from 'vitest';

import {
  findingsChangedRevision,
  markFindingsChanged,
  shouldRefreshOnFocus,
} from './findingsRefreshSignal';

describe('findings change signal', () => {
  it('advances the revision on every change so a consumer can spot one it has not seen', () => {
    const before = findingsChangedRevision();
    markFindingsChanged();
    const after = findingsChangedRevision();
    expect(after).toBeGreaterThan(before);

    markFindingsChanged();
    expect(findingsChangedRevision()).toBeGreaterThan(after);
  });

  it('does not move on its own', () => {
    const first = findingsChangedRevision();
    expect(findingsChangedRevision()).toBe(first);
  });
});

describe('shouldRefreshOnFocus', () => {
  const base = { now: 1_000_000, lastFetchAt: 1_000_000, debounceMs: 60_000 };

  it('holds off when the data is fresh and nothing changed', () => {
    expect(shouldRefreshOnFocus({ ...base, signalRevision: 3, seenRevision: 3 })).toBe(false);
  });

  it('refreshes once the debounce window has passed', () => {
    expect(
      shouldRefreshOnFocus({
        ...base,
        now: base.lastFetchAt + 60_000,
        signalRevision: 3,
        seenRevision: 3,
      }),
    ).toBe(true);
  });

  it('refreshes immediately after a finding was acted on, debounce or not', () => {
    // This is the whole point of the signal: acknowledging a finding must
    // update the Systems hero the moment the tech navigates back, not up to
    // a minute later.
    expect(shouldRefreshOnFocus({ ...base, signalRevision: 4, seenRevision: 3 })).toBe(true);
  });

  it('refreshes when the clock jumps backwards rather than stalling forever', () => {
    expect(
      shouldRefreshOnFocus({
        ...base,
        now: base.lastFetchAt - 5_000,
        signalRevision: 3,
        seenRevision: 3,
      }),
    ).toBe(true);
  });

  it('always refreshes before the first fetch has landed', () => {
    expect(
      shouldRefreshOnFocus({ now: 1_000, lastFetchAt: 0, debounceMs: 60_000, signalRevision: 0, seenRevision: 0 }),
    ).toBe(true);
  });
});
