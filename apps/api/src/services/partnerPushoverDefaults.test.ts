import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptColumnValueForWrite } from './encryptedColumnRegistry';
import { applyPartnerPushoverDefaults, readPartnerPushoverDefaults } from './partnerPushoverDefaults';

const ENV_KEYS = ['APP_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY_ID', 'ENABLE_AAD_V3'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe('partner Pushover defaults', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = 'pushover-defaults-test-key-material';
    process.env.APP_ENCRYPTION_KEY_ID = 'current';
    process.env.ENABLE_AAD_V3 = 'true';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('opens the token and user key sealed by the partner settings write path', () => {
    const settings = encryptColumnValueForWrite('partners', 'settings', {
      notifications: {
        pushoverAppToken: 'partner-app-token',
        pushoverDefaultUser: 'partner-user-key',
        pushoverDefaultSound: 'siren',
        pushoverDefaultPriority: 1,
      },
    }) as { notifications: Record<string, string> };
    expect(settings.notifications.pushoverAppToken).toMatch(/^enc:v3:/);

    expect(readPartnerPushoverDefaults(settings)).toEqual({
      appToken: 'partner-app-token',
      defaultUser: 'partner-user-key',
      defaultSound: 'siren',
      defaultPriority: 1,
    });
  });

  it('passes through values stored before sealing, and ignores blank or missing ones', () => {
    expect(readPartnerPushoverDefaults({ notifications: { pushoverAppToken: 'legacy-token', pushoverDefaultUser: '  ' } }))
      .toEqual({ appToken: 'legacy-token' });
    expect(readPartnerPushoverDefaults(null)).toEqual({});
    expect(readPartnerPushoverDefaults({ notifications: 'junk' })).toEqual({});
  });

  it('throws rather than sending a value that cannot be opened', () => {
    const sealedElsewhere = encryptColumnValueForWrite('organizations', 'settings', {
      notifications: { pushoverAppToken: 'org-token' },
    }) as { notifications: Record<string, string> };

    expect(() => readPartnerPushoverDefaults(sealedElsewhere)).toThrow();
  });

  it('fills only the fields the channel leaves blank', () => {
    const defaults = { appToken: 'p-token', defaultUser: 'p-user', defaultSound: 'siren', defaultPriority: 1 as const };

    expect(applyPartnerPushoverDefaults({ token: ' ', user: '' }, defaults))
      .toEqual({ token: 'p-token', user: 'p-user', sound: 'siren', priority: 1 });
    expect(applyPartnerPushoverDefaults({ token: 'c-token', user: 'c-user', sound: 'bike', priority: 0 }, defaults))
      .toEqual({ token: 'c-token', user: 'c-user', sound: 'bike', priority: 0 });
  });
});
