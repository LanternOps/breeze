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
    expect(providerFailureMessage({ cause, terminal: true }, false)).toMatch(pattern);
  });

  it('covers every provider failure cause', () => {
    for (const cause of PROVIDER_CAUSES) {
      expect(providerFailureMessage({ cause, terminal: true }, false)).not.toBe(PROVIDER_FAILURE_GENERIC_MESSAGE);
    }
  });

  it('a terminal failure before any output mentions the backup model (the offering was cooled)', () => {
    expect(providerFailureMessage({ cause: 'overloaded', terminal: true }, false)).toMatch(/backup model/);
  });

  it('a failure after output, or one the CLI never reported as final, does not promise a backup model', () => {
    expect(providerFailureMessage({ cause: 'overloaded', terminal: true }, true)).not.toMatch(/backup/);
    expect(providerFailureMessage({ cause: 'overloaded', terminal: false }, false)).not.toMatch(/backup/);
  });

  it('an unclassified failure gets the generic message', () => {
    expect(providerFailureMessage(null, false)).toBe(PROVIDER_FAILURE_GENERIC_MESSAGE);
  });
});
