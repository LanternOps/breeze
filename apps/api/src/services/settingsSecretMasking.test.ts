import { describe, expect, it } from 'vitest';
import {
  LOG_FORWARDING_SECRET_DESTINATIONS,
  MASKED_SETTINGS_SECRET,
  SettingsSecretInputError,
  maskSettingsSecrets,
  restoreMaskedSettingsSecrets,
  settingsSecretWouldFollowNewOrigin,
  withMaskedSettings,
} from './settingsSecretMasking';

const STORED_KEY = 'enc:v1:stored-api-key-ciphertext';
const STORED_PASSWORD = 'enc:v1:stored-password-ciphertext';

describe('maskSettingsSecrets', () => {
  it('replaces a sealed log-forwarding secret with the masked marker', () => {
    const masked = maskSettingsSecrets({
      eventLogs: { enabled: true, elasticsearchUrl: 'https://es.example.com', elasticsearchApiKey: STORED_KEY },
      logForwarding: { elasticsearchUsername: 'svc', elasticsearchPassword: STORED_PASSWORD },
    });

    expect(masked).toEqual({
      eventLogs: { enabled: true, elasticsearchUrl: 'https://es.example.com', elasticsearchApiKey: MASKED_SETTINGS_SECRET },
      logForwarding: { elasticsearchUsername: 'svc', elasticsearchPassword: MASKED_SETTINGS_SECRET },
    });
    expect(JSON.stringify(masked)).not.toContain('enc:');
  });

  it('masks a plaintext value stored under a secret key (legacy rows written before sealing)', () => {
    expect(maskSettingsSecrets({ eventLogs: { elasticsearchPassword: 'hunter2' } }))
      .toEqual({ eventLogs: { elasticsearchPassword: MASKED_SETTINGS_SECRET } });
  });

  it('masks sealed values under any key and inside arrays', () => {
    const masked = maskSettingsSecrets({
      remoteAccessProviders: {
        providers: [
          { id: 'rd', name: 'RustDesk', password: STORED_PASSWORD, enabled: true },
          { id: 'sc', name: 'ScreenConnect', enabled: true },
        ],
      },
      misc: { note: 'enc:v2:unexpected-sealed-value' },
    });

    expect(masked).toEqual({
      remoteAccessProviders: {
        providers: [
          { id: 'rd', name: 'RustDesk', password: MASKED_SETTINGS_SECRET, enabled: true },
          { id: 'sc', name: 'ScreenConnect', enabled: true },
        ],
      },
      misc: { note: MASKED_SETTINGS_SECRET },
    });
  });

  it('leaves empty secrets, non-secret strings and non-string values untouched', () => {
    const input = {
      eventLogs: { elasticsearchApiKey: '', indexPrefix: 'breeze-logs', enabled: false },
      security: { requireMfa: true, encrypted: true },
    };
    expect(maskSettingsSecrets(input)).toEqual(input);
    expect(maskSettingsSecrets(null)).toBeNull();
    expect(maskSettingsSecrets(undefined)).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const input = { eventLogs: { elasticsearchApiKey: STORED_KEY } };
    maskSettingsSecrets(input);
    expect(input.eventLogs.elasticsearchApiKey).toBe(STORED_KEY);
  });
});

describe('withMaskedSettings', () => {
  it('masks the settings column of a row and keeps every other column', () => {
    const row = { id: 'org-1', name: 'Org', settings: { eventLogs: { elasticsearchApiKey: STORED_KEY } } };
    expect(withMaskedSettings(row)).toEqual({
      id: 'org-1',
      name: 'Org',
      settings: { eventLogs: { elasticsearchApiKey: MASKED_SETTINGS_SECRET } },
    });
  });

  it('passes a row without a settings column through unchanged', () => {
    const row = { id: 'org-1', name: 'Org' };
    expect(withMaskedSettings(row)).toEqual(row);
  });
});

describe('restoreMaskedSettingsSecrets', () => {
  const stored = {
    eventLogs: { enabled: true, elasticsearchUrl: 'https://es.example.com', elasticsearchApiKey: STORED_KEY },
  };

  it('keeps the stored secret when the client echoes the masked marker', () => {
    const next = restoreMaskedSettingsSecrets(
      { eventLogs: { enabled: false, elasticsearchUrl: 'https://es.example.com', elasticsearchApiKey: MASKED_SETTINGS_SECRET } },
      stored,
    );
    expect(next).toEqual({
      eventLogs: { enabled: false, elasticsearchUrl: 'https://es.example.com', elasticsearchApiKey: STORED_KEY },
    });
  });

  it('accepts the shorter asterisk marker older log-forwarding responses used', () => {
    const next = restoreMaskedSettingsSecrets({ eventLogs: { elasticsearchApiKey: '****' } }, stored) as typeof stored;
    expect(next.eventLogs.elasticsearchApiKey).toBe(STORED_KEY);
  });

  it('keeps the stored secret when the key is omitted from a present category', () => {
    const next = restoreMaskedSettingsSecrets(
      { eventLogs: { enabled: true, elasticsearchUrl: 'https://es.example.com' } },
      stored,
    ) as typeof stored;
    expect(next.eventLogs.elasticsearchApiKey).toBe(STORED_KEY);
  });

  it('does not resurrect secrets for a category the client dropped entirely', () => {
    expect(restoreMaskedSettingsSecrets({ branding: { theme: 'dark' } }, stored))
      .toEqual({ branding: { theme: 'dark' } });
  });

  it('lets a freshly typed value replace the stored secret', () => {
    const next = restoreMaskedSettingsSecrets({ eventLogs: { elasticsearchApiKey: 'new-plaintext-key' } }, stored) as typeof stored;
    expect(next.eventLogs.elasticsearchApiKey).toBe('new-plaintext-key');
  });

  it('lets an empty string clear the stored secret', () => {
    const next = restoreMaskedSettingsSecrets({ eventLogs: { elasticsearchApiKey: '' } }, stored) as typeof stored;
    expect(next.eventLogs.elasticsearchApiKey).toBe('');
  });

  it('accepts the stored ciphertext echoed back unchanged (a page loaded before masking)', () => {
    const next = restoreMaskedSettingsSecrets({ eventLogs: { elasticsearchApiKey: STORED_KEY } }, stored) as typeof stored;
    expect(next.eventLogs.elasticsearchApiKey).toBe(STORED_KEY);
  });

  it('refuses ciphertext that is not the value stored at that path', () => {
    expect(() => restoreMaskedSettingsSecrets(
      { eventLogs: { elasticsearchApiKey: 'enc:v1:ciphertext-from-somewhere-else' } },
      stored,
    )).toThrow(SettingsSecretInputError);
  });

  it('drops a masked marker that has no stored secret behind it', () => {
    expect(restoreMaskedSettingsSecrets({ eventLogs: { elasticsearchPassword: MASKED_SETTINGS_SECRET } }, stored))
      .toEqual({ eventLogs: { elasticsearchPassword: undefined, elasticsearchApiKey: STORED_KEY } });
  });

  it('resolves array entries by id, so a reorder cannot swap secrets between entries', () => {
    const storedProviders = {
      remoteAccessProviders: {
        providers: [
          { id: 'a', password: 'enc:v1:password-a' },
          { id: 'b', password: 'enc:v1:password-b' },
        ],
      },
    };
    const next = restoreMaskedSettingsSecrets(
      {
        remoteAccessProviders: {
          providers: [
            { id: 'b', password: MASKED_SETTINGS_SECRET },
            { id: 'a', password: MASKED_SETTINGS_SECRET },
            { id: 'c', password: MASKED_SETTINGS_SECRET },
          ],
        },
      },
      storedProviders,
    );
    expect(next).toEqual({
      remoteAccessProviders: {
        providers: [
          { id: 'b', password: 'enc:v1:password-b' },
          { id: 'a', password: 'enc:v1:password-a' },
          { id: 'c', password: undefined },
        ],
      },
    });
  });

  it('leaves a literal asterisk string under a non-secret key alone', () => {
    expect(restoreMaskedSettingsSecrets({ branding: { tagline: '****' } }, {}))
      .toEqual({ branding: { tagline: '****' } });
  });
});

describe('settingsSecretWouldFollowNewOrigin', () => {
  const stored = {
    eventLogs: { elasticsearchUrl: 'https://es.trusted.example', elasticsearchApiKey: STORED_KEY },
    logForwarding: { elasticsearchUrl: 'https://logs.trusted.example', elasticsearchPassword: STORED_PASSWORD },
  };
  const check = (incoming: unknown) =>
    settingsSecretWouldFollowNewOrigin(incoming, stored, LOG_FORWARDING_SECRET_DESTINATIONS);

  it('is true when the URL origin changes and the secret is kept by the masked marker', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: MASKED_SETTINGS_SECRET } })).toBe(true);
  });

  it('is true when the URL origin changes and the secret is kept by omission', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example' } })).toBe(true);
  });

  it('is true when the URL origin changes and the stored ciphertext is echoed', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: STORED_KEY } })).toBe(true);
  });

  it('covers the logForwarding destination the same way', () => {
    expect(check({ logForwarding: { elasticsearchUrl: 'https://logs.other.example', elasticsearchPassword: MASKED_SETTINGS_SECRET } })).toBe(true);
  });

  it('is false when a fresh secret is typed alongside the new URL', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: 'typed-key' } })).toBe(false);
  });

  it('is false when the secret is cleared alongside the new URL', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: '' } })).toBe(false);
  });

  it('is false when only the path changes within the same origin', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.trusted.example/new-path', elasticsearchApiKey: MASKED_SETTINGS_SECRET } })).toBe(false);
  });

  it('is false when the category or the URL is absent from the request', () => {
    expect(check({ branding: {} })).toBe(false);
    expect(check({ eventLogs: { enabled: false, elasticsearchApiKey: MASKED_SETTINGS_SECRET } })).toBe(false);
  });

  it('fails closed when a secret is stored but no destination URL was recorded for it', () => {
    expect(settingsSecretWouldFollowNewOrigin(
      { eventLogs: { elasticsearchUrl: 'https://es.new.example', elasticsearchApiKey: MASKED_SETTINGS_SECRET } },
      { eventLogs: { elasticsearchApiKey: STORED_KEY } },
      LOG_FORWARDING_SECRET_DESTINATIONS,
    )).toBe(true);
  });

  it('is false when nothing is stored to carry', () => {
    expect(settingsSecretWouldFollowNewOrigin(
      { eventLogs: { elasticsearchUrl: 'https://es.new.example' } },
      {},
      LOG_FORWARDING_SECRET_DESTINATIONS,
    )).toBe(false);
  });
});
