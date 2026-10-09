import { describe, expect, it } from 'vitest';
import { FAILOVER_CAUSES, type ProviderFailureCause } from './failover';
import { PROVIDER_FAILURE_GENERIC_MESSAGE, providerFailureMessage } from './providerFailureMessage';

const PROVIDER_CAUSES = FAILOVER_CAUSES.filter(
  (c): c is ProviderFailureCause => c !== 'ineligible' && c !== 'cooldown',
);

describe('providerFailureMessage (#7785)', () => {
  it.each([
    ['overloaded', /overloaded/i],
    ['rate_limited', /rate-limit/i],
    ['server_error', /server error/i],
    ['auth_failed', /credentials/i],
    ['quota_exhausted', /credit or quota/i],
  ] as const)('%s names the provider failure', (cause, pattern) => {
    expect(providerFailureMessage(cause, false)).toMatch(pattern);
  });

  it('covers every provider failure cause', () => {
    for (const cause of PROVIDER_CAUSES) {
      expect(providerFailureMessage(cause, false)).not.toBe(PROVIDER_FAILURE_GENERIC_MESSAGE);
    }
  });

  it('a failure before any output mentions the backup model (the offering was cooled)', () => {
    expect(providerFailureMessage('overloaded', false)).toMatch(/backup model/);
  });

  it('a failure after output does not promise a backup model (nothing was cooled)', () => {
    expect(providerFailureMessage('overloaded', true)).not.toMatch(/backup/);
  });

  it('an unclassified failure gets the generic message', () => {
    expect(providerFailureMessage(null, false)).toBe(PROVIDER_FAILURE_GENERIC_MESSAGE);
  });
});
