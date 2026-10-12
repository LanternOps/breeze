import { describe, it, expect } from 'vitest';
import {
  SESSION_TIMEOUT_MAX_MINUTES,
  sessionTimeoutWithinCeiling,
  clampSessionTimeoutInSettings,
} from './sessionTimeoutPolicy';

describe('session timeout ceiling (#6111)', () => {
  it('is 12 hours', () => {
    expect(SESSION_TIMEOUT_MAX_MINUTES).toBe(720);
  });

  it.each([
    [undefined], [null], [{}], [{ security: {} }], [{ security: { sessionTimeout: 60 } }],
    [{ security: { sessionTimeout: 720 } }],
  ])('accepts %j', (settings) => {
    expect(sessionTimeoutWithinCeiling(settings)).toBe(true);
  });

  it.each([[{ security: { sessionTimeout: 721 } }], [{ security: { sessionTimeout: 1440 } }]])(
    'rejects %j',
    (settings) => {
      expect(sessionTimeoutWithinCeiling(settings)).toBe(false);
    },
  );

  it('clamps a stored value above the ceiling without mutating the input', () => {
    const stored = { security: { sessionTimeout: 1440, requireMfa: true }, other: 1 };
    const out = clampSessionTimeoutInSettings(stored) as any;
    expect(out.security.sessionTimeout).toBe(720);
    expect(out.security.requireMfa).toBe(true);
    expect(stored.security.sessionTimeout).toBe(1440);
  });

  it('leaves in-range values and non-numeric input alone', () => {
    const ok = { security: { sessionTimeout: 90 } };
    expect(clampSessionTimeoutInSettings(ok)).toBe(ok);
    expect(clampSessionTimeoutInSettings(null)).toBeNull();
    expect(clampSessionTimeoutInSettings({ security: null })).toEqual({ security: null });
  });
});
