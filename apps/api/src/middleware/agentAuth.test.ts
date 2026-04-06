import { describe, expect, it, vi, afterEach } from 'vitest';

import { isAgentTokenRotationDue, matchAgentTokenHash } from './agentAuth';
import { createHash } from 'crypto';

function sha(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('matchAgentTokenHash', () => {
  it('matches the current token hash without rotation requirement', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date(Date.now() + 60_000),
      tokenHash: sha('brz_current'),
    });

    expect(result).toEqual({ tokenRotationRequired: false });
  });

  it('matches the previous token hash only while the grace window is active', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date('2026-03-31T18:05:00Z'),
      tokenHash: sha('brz_previous'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toEqual({ tokenRotationRequired: true });
  });

  it('rejects the previous token once the grace window expires', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date('2026-03-31T17:59:00Z'),
      tokenHash: sha('brz_previous'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toBeNull();
  });
});

describe('isAgentTokenRotationDue', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires rotation when the token was never issued with a tracked timestamp', () => {
    expect(isAgentTokenRotationDue(null, new Date('2026-03-31T18:00:00Z'))).toBe(true);
  });

  it('uses the configured max age threshold', () => {
    vi.stubEnv('AGENT_TOKEN_ROTATION_MAX_AGE_DAYS', '7');

    expect(
      isAgentTokenRotationDue(
        new Date('2026-03-20T18:00:00Z'),
        new Date('2026-03-31T18:00:00Z')
      )
    ).toBe(true);

    expect(
      isAgentTokenRotationDue(
        new Date('2026-03-28T18:00:00Z'),
        new Date('2026-03-31T18:00:00Z')
      )
    ).toBe(false);
  });
});
