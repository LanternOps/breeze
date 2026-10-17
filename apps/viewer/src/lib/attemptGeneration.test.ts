import { describe, expect, it, vi } from 'vitest';
import { createAttemptGeneration } from './attemptGeneration';

function wrapper() {
  return { close: vi.fn() };
}

describe('createAttemptGeneration (#8947)', () => {
  it('a fresh attempt is current', () => {
    const gen = createAttemptGeneration();
    const attempt = gen.begin();
    expect(attempt.isStale()).toBe(false);
  });

  it('a newer attempt makes the older one stale', () => {
    const gen = createAttemptGeneration();
    const first = gen.begin();
    const second = gen.begin();
    expect(first.isStale()).toBe(true);
    expect(second.isStale()).toBe(false);
  });

  it('invalidate() makes the in-flight attempt stale (owner cancelled)', () => {
    const gen = createAttemptGeneration();
    const attempt = gen.begin();
    gen.invalidate();
    expect(attempt.isStale()).toBe(true);
  });

  it('adopt() hands back the result of a current attempt untouched', () => {
    const gen = createAttemptGeneration();
    const attempt = gen.begin();
    const w = wrapper();
    expect(attempt.adopt(w)).toBe(w);
    expect(w.close).not.toHaveBeenCalled();
  });

  // The regression: the cancelled connect run used to install its wrapper and
  // then close whatever was in the shared ref — the newer run's live peer — or
  // leave its own peer streaming into the <video> with nobody listening.
  it('adopt() closes the result of a cancelled attempt and returns null', () => {
    const gen = createAttemptGeneration();
    const cancelled = gen.begin();
    const live = gen.begin();
    const stale = wrapper();
    const fresh = wrapper();

    expect(cancelled.adopt(stale)).toBeNull();
    expect(stale.close).toHaveBeenCalledTimes(1);

    expect(live.adopt(fresh)).toBe(fresh);
    expect(fresh.close).not.toHaveBeenCalled();
  });

  it('adopt() passes a null result through', () => {
    const gen = createAttemptGeneration();
    const attempt = gen.begin();
    gen.invalidate();
    expect(attempt.adopt(null)).toBeNull();
  });
});
