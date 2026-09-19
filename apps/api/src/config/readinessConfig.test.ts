import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_READINESS_CACHE_TTL_MS,
  DEFAULT_READINESS_PROBE_TIMEOUT_MS,
  READINESS_TRANSITION_VISIBILITY_THRESHOLD_MS,
  resolveReadinessTiming,
} from './readinessConfig';

describe('resolveReadinessTiming', () => {
  it('uses the documented defaults within the visibility threshold', () => {
    const timing = resolveReadinessTiming({});

    expect(timing).toEqual({
      ttlMs: DEFAULT_READINESS_CACHE_TTL_MS,
      probeTimeoutMs: DEFAULT_READINESS_PROBE_TIMEOUT_MS,
      transitionVisibilityThresholdMs: READINESS_TRANSITION_VISIBILITY_THRESHOLD_MS,
    });
    expect(timing.ttlMs + timing.probeTimeoutMs).toBeLessThanOrEqual(10_000);
  });

  it.each([
    [{ READINESS_PROBE_TIMEOUT_MS: '99' }, { ttlMs: 5_000, probeTimeoutMs: 100 }],
    [{ READINESS_PROBE_TIMEOUT_MS: '5001' }, { ttlMs: 5_000, probeTimeoutMs: 5_000 }],
    [{ READINESS_CACHE_TTL_MS: '-1' }, { ttlMs: 0, probeTimeoutMs: 3_000 }],
    [{ READINESS_CACHE_TTL_MS: '99999' }, { ttlMs: 7_000, probeTimeoutMs: 3_000 }],
    [
      { READINESS_CACHE_TTL_MS: '9000', READINESS_PROBE_TIMEOUT_MS: '5000' },
      { ttlMs: 5_000, probeTimeoutMs: 5_000 },
    ],
  ])('clamps timing input %o', (env, expected) => {
    const onClamp = vi.fn();
    const timing = resolveReadinessTiming(env, onClamp);

    expect(timing).toMatchObject(expected);
    expect(timing.ttlMs + timing.probeTimeoutMs).toBeLessThanOrEqual(10_000);
    expect(onClamp).toHaveBeenCalled();
  });

  it('uses defaults for non-integer values without logging untrusted input', () => {
    const onClamp = vi.fn();
    const timing = resolveReadinessTiming({
      READINESS_CACHE_TTL_MS: 'secret://not-an-integer',
      READINESS_PROBE_TIMEOUT_MS: '1.5',
    }, onClamp);

    expect(timing.ttlMs).toBe(5_000);
    expect(timing.probeTimeoutMs).toBe(3_000);
    expect(onClamp).not.toHaveBeenCalled();
  });
});
