import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  openSsoExchangeCode,
  sealSsoExchangeCode,
} from './ssoBrowserTransition';

const payload = {
  accessToken: 'access-token-secret',
  refreshToken: 'refresh-token-secret',
  expiresInSeconds: 900,
};

describe('durable SSO exchange code envelope', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENCRYPTION_KEY = 'sso-exchange-test-key-material-at-least-32-bytes';
    process.env.APP_ENCRYPTION_KEY_ID = 'sso-current';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      'sso-current': 'sso-exchange-test-key-material-at-least-32-bytes',
    });
  });

  it('persists only a digest while the opaque code round-trips the token handoff', () => {
    const sealed = sealSsoExchangeCode(payload);

    expect(sealed.code).not.toContain(payload.accessToken);
    expect(sealed.code).not.toContain(payload.refreshToken);
    expect(sealed.codeDigest).toBe(
      createHash('sha256').update(sealed.code, 'utf8').digest('hex'),
    );
    expect(sealed.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(openSsoExchangeCode(sealed.code)).toEqual(payload);
  });

  it('uses randomized authenticated encryption and rejects alteration', () => {
    const first = sealSsoExchangeCode(payload);
    const second = sealSsoExchangeCode(payload);

    expect(first.code).not.toBe(second.code);
    expect(() => openSsoExchangeCode(`${first.code.slice(0, -1)}x`)).toThrow();
  });
});
