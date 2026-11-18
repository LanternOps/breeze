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

  // #9534: a rejected PLATFORM key surfaced the CLI's "Invalid API key · Fix
  // external API key", which sends a hosted partner user to a BYO-key page
  // that cannot fix a server credential. The two key owners get different
  // instructions, and neither is told to "try again shortly" — a bad key
  // does not fix itself.
  describe('auth_failed names who can fix the key (#9534)', () => {
    it('platform key: the server key was rejected, contact the administrator', () => {
      const text = providerFailureMessage('auth_failed', false, { platformKey: true });
      expect(text).toMatch(/server's API key/);
      expect(text).toMatch(/contact your administrator/i);
      expect(text).not.toMatch(/try again shortly/i);
    });

    it('partner (BYO / external) key: the key configured for this model, fixed in AI model settings', () => {
      const text = providerFailureMessage('auth_failed', false, { platformKey: false });
      expect(text).not.toMatch(/server's/);
      expect(text).toMatch(/API key configured for this model/);
      expect(text).toMatch(/AI model settings/);
      expect(text).not.toMatch(/try again shortly/i);
    });

    it('the two are distinct, and both keep the backup-model note only before output', () => {
      const platform = providerFailureMessage('auth_failed', false, { platformKey: true });
      const partner = providerFailureMessage('auth_failed', false, { platformKey: false });
      expect(platform).not.toBe(partner);
      expect(platform).toMatch(/backup model/);
      expect(providerFailureMessage('auth_failed', true, { platformKey: true })).not.toMatch(/backup/);
    });

    it('other causes are unchanged by the key owner', () => {
      expect(providerFailureMessage('overloaded', false, { platformKey: true }))
        .toBe(providerFailureMessage('overloaded', false, { platformKey: false }));
    });
  });
});
