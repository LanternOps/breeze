import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSourceCredentials, sealSourceCredentials, sourceCredentialsSchema } from './sourceCredentials';

const ENV_KEYS = ['APP_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING', 'JWT_SECRET', 'SESSION_SECRET'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const SOURCE_A = '11111111-1111-4111-8111-111111111111';
const SOURCE_B = '22222222-2222-4222-8222-222222222222';

describe('ticket import source credentials (row-bound)', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.APP_ENCRYPTION_KEY = 'legacy-key-material-for-tests';
    process.env.APP_ENCRYPTION_KEY_ID = 'current';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: 'current-key-material-for-tests' });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('round-trips a credential under its own row id, never storing the plaintext', () => {
    const sealed = sealSourceCredentials(SOURCE_A, { token: 'zammad-token-123' });
    expect(sealed).toMatch(/^enc:v\d+:current:/);
    expect(sealed).not.toContain('zammad-token-123');
    expect(openSourceCredentials(SOURCE_A, sealed)).toEqual({ token: 'zammad-token-123' });
  });

  it('refuses a ciphertext pasted into another source row', () => {
    const sealed = sealSourceCredentials(SOURCE_A, { token: 'zammad-token-123' });
    expect(() => openSourceCredentials(SOURCE_B, sealed)).toThrow();
  });

  it('requires a row id to seal or open', () => {
    expect(() => sealSourceCredentials('', { token: 'x' })).toThrow(/row-bound/);
    expect(() => openSourceCredentials('', 'enc:v2:current:abc')).toThrow(/row-bound/);
  });

  it('never echoes the plaintext when the sealed value has the wrong shape', () => {
    const sealed = sealSourceCredentials(SOURCE_A, { token: 'ok' });
    // A valid seal of a shape the schema refuses (no keys) is caught on open.
    const empty = sealSourceCredentials(SOURCE_A, {} as Record<string, string>);
    expect(() => openSourceCredentials(SOURCE_A, empty)).toThrow(/unexpected shape/);
    expect(openSourceCredentials(SOURCE_A, sealed)).toEqual({ token: 'ok' });
  });

  it('accepts one to eight named strings', () => {
    expect(sourceCredentialsSchema.safeParse({ token: 'a' }).success).toBe(true);
    expect(sourceCredentialsSchema.safeParse({ email: 'a@b.test', apiKey: 'k' }).success).toBe(true);
    expect(sourceCredentialsSchema.safeParse({}).success).toBe(false);
    expect(sourceCredentialsSchema.safeParse({ token: '' }).success).toBe(false);
    expect(sourceCredentialsSchema.safeParse({ '1bad': 'x' }).success).toBe(false);
    expect(sourceCredentialsSchema.safeParse({ token: 'x'.repeat(4097) }).success).toBe(false);
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']));
    expect(sourceCredentialsSchema.safeParse(nine).success).toBe(false);
  });
});
