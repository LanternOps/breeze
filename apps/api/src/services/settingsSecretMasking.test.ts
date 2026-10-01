import { describe, expect, it } from 'vitest';
import {
  MASKED_SETTINGS_SECRET,
  SettingsSecretInputError,
  keepsStoredSettingsSecret,
  maskSettingsSecrets,
  restoreMaskedSettingsSecrets,
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

describe('notification channel secrets in settings', () => {
  const SLACK = 'https://hooks.slack.example/services/T000/B000/abcdef';
  const EXTRA_A = 'https://hooks.example.com/a?token=aaa';
  const SEALED_A = 'enc:v1:webhook-a';
  const SEALED_B = 'enc:v1:webhook-b';
  const SEALED_C = 'enc:v1:webhook-c';
  const TAGGED = /^\*{8}:[0-9a-f]{16}$/;

  /** What a GET returns for a stored webhook list: one keyed marker per entry. */
  function maskedList(list: string[]): string[] {
    return (maskSettingsSecrets({ notifications: { webhooks: list } }) as { notifications: { webhooks: string[] } })
      .notifications.webhooks;
  }

  it('masks the Slack URL, Pushover credentials and every extra webhook URL, sealed or not', () => {
    const masked = maskSettingsSecrets({
      notifications: {
        slackWebhookUrl: SLACK,
        slackChannel: '#ops-alerts',
        pushoverAppToken: 'enc:v1:app-token',
        pushoverDefaultUser: 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG',
        pushoverDefaultSound: 'pushover',
        webhooks: [EXTRA_A, SEALED_B, ''],
      },
    }) as { notifications: Record<string, unknown> };

    const { webhooks, ...scalars } = masked.notifications;
    expect(scalars).toEqual({
      slackWebhookUrl: MASKED_SETTINGS_SECRET,
      slackChannel: '#ops-alerts',
      pushoverAppToken: MASKED_SETTINGS_SECRET,
      pushoverDefaultUser: MASKED_SETTINGS_SECRET,
      pushoverDefaultSound: 'pushover',
    });
    const list = webhooks as string[];
    expect(list[0]).toMatch(TAGGED);
    expect(list[1]).toMatch(TAGGED);
    expect(list[0]).not.toBe(list[1]);
    expect(list[2]).toBe('');
    expect(JSON.stringify(masked)).not.toContain('hooks.example');
  });

  it('keys each masked list entry to its stored value, not its position', () => {
    expect(maskedList([SEALED_A, SEALED_B])).toEqual(maskedList([SEALED_B, SEALED_A]).reverse());
  });

  it('does not mask a `webhooks` list outside notifications', () => {
    const input = { ticketing: { webhooks: ['ticket.created'] } };
    expect(maskSettingsSecrets(input)).toEqual(input);
  });

  const stored = {
    notifications: {
      slackWebhookUrl: 'enc:v1:slack',
      pushoverAppToken: 'enc:v1:app-token',
      webhooks: [SEALED_A, SEALED_B],
    },
  };

  it('keeps every stored value when the editor echoes the masked blob back', () => {
    const next = restoreMaskedSettingsSecrets(maskSettingsSecrets(stored), stored);
    expect(next).toEqual(stored);
  });

  it('replaces a typed Slack URL and clears one sent as an empty string', () => {
    const next = restoreMaskedSettingsSecrets({
      notifications: { slackWebhookUrl: SLACK, pushoverAppToken: '' },
    }, stored) as { notifications: Record<string, unknown> };
    expect(next.notifications.slackWebhookUrl).toBe(SLACK);
    expect(next.notifications.pushoverAppToken).toBe('');
  });

  it('keeps the entries the editor sends back, drops the ones it left out, and appends typed ones', () => {
    const [, maskedB] = maskedList([SEALED_A, SEALED_B]);
    const next = restoreMaskedSettingsSecrets({
      notifications: { webhooks: [maskedB, EXTRA_A] },
    }, stored) as { notifications: { webhooks: string[] } };
    expect(next.notifications.webhooks).toEqual([SEALED_B, EXTRA_A]);
  });

  it('refuses a stale list whose kept entry is no longer stored, rather than keeping the wrong one', () => {
    // Loaded as [A, B]. Another save removed A and added C, so the stored list
    // is [B, C]. This page removed B and saves [keep A].
    const [maskedA] = maskedList([SEALED_A, SEALED_B]);
    expect(() => restoreMaskedSettingsSecrets(
      { notifications: { webhooks: [maskedA] } },
      { notifications: { webhooks: [SEALED_B, SEALED_C] } },
    )).toThrow(SettingsSecretInputError);
  });

  it('refuses a bare marker in the list, which cannot say which entry it keeps', () => {
    expect(() => restoreMaskedSettingsSecrets({
      notifications: { webhooks: [MASKED_SETTINGS_SECRET] },
    }, stored)).toThrow(SettingsSecretInputError);
  });

  it('keeps the stored webhook list when the key is omitted from a present notifications object', () => {
    const next = restoreMaskedSettingsSecrets({ notifications: { slackChannel: '#ops' } }, stored) as {
      notifications: Record<string, unknown>;
    };
    expect(next.notifications.webhooks).toEqual([SEALED_A, SEALED_B]);
    expect(next.notifications.slackWebhookUrl).toBe('enc:v1:slack');
  });

  it('accepts stored ciphertext echoed back unchanged, and refuses ciphertext that is not stored', () => {
    const echoed = restoreMaskedSettingsSecrets({
      notifications: { webhooks: [SEALED_B, SEALED_A] },
    }, stored) as { notifications: { webhooks: string[] } };
    expect(echoed.notifications.webhooks).toEqual([SEALED_B, SEALED_A]);
    expect(() => restoreMaskedSettingsSecrets({
      notifications: { webhooks: [SEALED_C] },
    }, stored)).toThrow(SettingsSecretInputError);
  });
});

describe('keepsStoredSettingsSecret', () => {
  const maskedA = (maskSettingsSecrets({ notifications: { webhooks: ['enc:v1:a'] } }) as {
    notifications: { webhooks: string[] };
  }).notifications.webhooks[0];

  it('is true for the marker echoed back for a stored secret, or for nothing stored', () => {
    expect(keepsStoredSettingsSecret('notifications', 'slackWebhookUrl', MASKED_SETTINGS_SECRET, 'enc:v1:slack')).toBe(true);
    expect(keepsStoredSettingsSecret('notifications', 'slackWebhookUrl', MASKED_SETTINGS_SECRET, undefined)).toBe(true);
    expect(keepsStoredSettingsSecret('notifications', 'webhooks', [maskedA], ['enc:v1:a'])).toBe(true);
  });

  it('is false for a typed value, a removal, a shortened list, or a non-secret field', () => {
    expect(keepsStoredSettingsSecret('notifications', 'slackWebhookUrl', 'https://hooks.slack.example/x', 'enc:v1:slack')).toBe(false);
    expect(keepsStoredSettingsSecret('notifications', 'slackWebhookUrl', '', 'enc:v1:slack')).toBe(false);
    expect(keepsStoredSettingsSecret('notifications', 'webhooks', [maskedA], ['enc:v1:a', 'enc:v1:b'])).toBe(false);
    expect(keepsStoredSettingsSecret('notifications', 'webhooks', [], ['enc:v1:a'])).toBe(false);
    expect(keepsStoredSettingsSecret('notifications', 'slackChannel', MASKED_SETTINGS_SECRET, '#ops')).toBe(false);
  });
});
