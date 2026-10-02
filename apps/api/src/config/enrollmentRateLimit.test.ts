import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnrollmentRateLimit } from './enrollmentRateLimit';

describe('getEnrollmentRateLimit (#7472)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 10 per 60s when unset', () => {
    expect(getEnrollmentRateLimit()).toEqual({ limit: 10, windowSeconds: 60 });
  });

  it('treats the compose-rendered empty string as unset', () => {
    vi.stubEnv('AGENT_ENROLL_RATE_LIMIT', '');
    vi.stubEnv('AGENT_ENROLL_RATE_WINDOW_SECONDS', '');
    expect(getEnrollmentRateLimit()).toEqual({ limit: 10, windowSeconds: 60 });
  });

  it('honors operator overrides', () => {
    vi.stubEnv('AGENT_ENROLL_RATE_LIMIT', '120');
    vi.stubEnv('AGENT_ENROLL_RATE_WINDOW_SECONDS', '30');
    expect(getEnrollmentRateLimit()).toEqual({ limit: 120, windowSeconds: 30 });
  });

  it.each(['0', '-5', 'abc', '5e3'])('falls back to defaults for invalid %s', (v) => {
    vi.stubEnv('AGENT_ENROLL_RATE_LIMIT', v);
    vi.stubEnv('AGENT_ENROLL_RATE_WINDOW_SECONDS', v);
    expect(getEnrollmentRateLimit()).toEqual({ limit: 10, windowSeconds: 60 });
  });
});
