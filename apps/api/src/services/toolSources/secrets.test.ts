import { createHash, createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

// Secret-crypto env bootstrap copied verbatim from `partnerLlmConfig.test.ts` —
// `encryptSecret`/`decryptSecret` derive their key from `APP_ENCRYPTION_KEY`,
// and the AAD-binding assertions below need a stable, known key so the
// fingerprint can be recomputed independently of the implementation.
const originalEncryptionEnv = {
  key: process.env.APP_ENCRYPTION_KEY,
  keyId: process.env.APP_ENCRYPTION_KEY_ID,
  keyring: process.env.APP_ENCRYPTION_KEYRING,
};

process.env.APP_ENCRYPTION_KEY = 'partner-llm-unit-test-key-material';
process.env.APP_ENCRYPTION_KEY_ID = 'partner-llm-test';
delete process.env.APP_ENCRYPTION_KEYRING;

afterAll(() => {
  if (originalEncryptionEnv.key === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = originalEncryptionEnv.key;
  if (originalEncryptionEnv.keyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
  else process.env.APP_ENCRYPTION_KEY_ID = originalEncryptionEnv.keyId;
  if (originalEncryptionEnv.keyring === undefined) delete process.env.APP_ENCRYPTION_KEYRING;
  else process.env.APP_ENCRYPTION_KEYRING = originalEncryptionEnv.keyring;
});

import {
  credentialOriginFor,
  decryptToolSourceAuth,
  encryptToolSourceAuth,
  redactSecrets,
  secretValuesOf,
  type ToolSourceAuthConfig,
} from './secrets';

const ROW_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ROW_ID = '22222222-2222-4222-8222-222222222222';

function expectedFingerprint(value: string): string {
  const encryptionKey = createHash('sha256').update('partner-llm-unit-test-key-material').digest();
  const hex = createHmac('sha256', encryptionKey).update(value).digest('hex');
  return `fp1:partner-llm-test:${hex}`;
}

describe('encryptToolSourceAuth / decryptToolSourceAuth', () => {
  const cases: Array<{ name: string; cfg: ToolSourceAuthConfig }> = [
    { name: 'bearer', cfg: { authKind: 'bearer', token: 'tok_live_abc123' } },
    {
      name: 'api_key_header',
      cfg: { authKind: 'api_key_header', headerName: 'X-Api-Key', value: 'key_abc123' },
    },
    { name: 'basic', cfg: { authKind: 'basic', username: 'svc-account', password: 'p@ssw0rd!' } },
    {
      name: 'oauth2_client_credentials',
      cfg: {
        authKind: 'oauth2_client_credentials',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'client-123',
        clientSecret: 'client-secret-xyz',
        scope: 'tools:read',
      },
    },
  ];

  for (const { name, cfg } of cases) {
    it(`round-trips ${name}`, () => {
      const { encrypted, fingerprint } = encryptToolSourceAuth(ROW_ID, cfg);
      expect(encrypted).not.toBeNull();
      expect(fingerprint).toBe(expectedFingerprint(JSON.stringify(cfg)));

      const decrypted = decryptToolSourceAuth({
        id: ROW_ID,
        authKind: cfg.authKind,
        authConfigEncrypted: encrypted,
      });
      expect(decrypted).toEqual(cfg);
    });
  }

  it('encrypts authKind "none" to a null blob and null fingerprint', () => {
    const { encrypted, fingerprint } = encryptToolSourceAuth(ROW_ID, { authKind: 'none' });
    expect(encrypted).toBeNull();
    expect(fingerprint).toBeNull();

    const decrypted = decryptToolSourceAuth({
      id: ROW_ID,
      authKind: 'none',
      authConfigEncrypted: null,
    });
    expect(decrypted).toEqual({ authKind: 'none' });
  });

  it('refuses to decrypt under a different row id (AAD binding)', () => {
    const { encrypted } = encryptToolSourceAuth(ROW_ID, {
      authKind: 'bearer',
      token: 'tok_live_abc123',
    });

    expect(() =>
      decryptToolSourceAuth({
        id: OTHER_ROW_ID,
        authKind: 'bearer',
        authConfigEncrypted: encrypted,
      }),
    ).toThrow();
  });
});

describe('credentialOriginFor', () => {
  it('drops path, query, and fragment but keeps scheme/host/port', () => {
    expect(credentialOriginFor('https://a.example:8443/mcp?x=1')).toBe('https://a.example:8443');
  });

  it('normalizes the default port away', () => {
    expect(credentialOriginFor('https://a.example/mcp')).toBe('https://a.example');
  });
});

describe('secretValuesOf', () => {
  it('returns no secrets for authKind "none"', () => {
    expect(secretValuesOf({ authKind: 'none' })).toEqual([]);
  });

  it('returns the bearer token', () => {
    expect(secretValuesOf({ authKind: 'bearer', token: 'tok_live_abc123' })).toEqual([
      'tok_live_abc123',
    ]);
  });

  it('returns only the header value for api_key_header — never the header name', () => {
    const secrets = secretValuesOf({
      authKind: 'api_key_header',
      headerName: 'X-Api-Key',
      value: 'key_abc123',
    });
    expect(secrets).toEqual(['key_abc123']);
    expect(secrets).not.toContain('X-Api-Key');
  });

  it('returns BOTH username and password for basic auth', () => {
    const secrets = secretValuesOf({
      authKind: 'basic',
      username: 'svc-account',
      password: 'p@ssw0rd!',
    });
    expect(secrets).toEqual(['svc-account', 'p@ssw0rd!']);
    expect(secrets).toContain('svc-account');
    expect(secrets).toContain('p@ssw0rd!');
  });

  it('returns only the client secret for oauth2_client_credentials — never tokenUrl/clientId/scope', () => {
    const secrets = secretValuesOf({
      authKind: 'oauth2_client_credentials',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'client-123',
      clientSecret: 'client-secret-xyz',
      scope: 'tools:read',
    });
    expect(secrets).toEqual(['client-secret-xyz']);
    expect(secrets).not.toContain('client-123');
    expect(secrets).not.toContain('https://auth.example.com/token');
    expect(secrets).not.toContain('tools:read');
  });
});

describe('redactSecrets', () => {
  it('removes a literal secret and generic Bearer/JWT shapes', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const text = `Authorization: Bearer ${jwt} token=K1`;
    const redacted = redactSecrets(text, ['K1']);
    expect(redacted).not.toContain('K1');
    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain('[REDACTED]');
  });

  it('removes a generic sk- shaped secret even when not passed as a literal', () => {
    const redacted = redactSecrets('key is sk-abcdefghijklmnopqrstuvwxyz', []);
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(redacted).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'The device rebooted successfully at 03:00 UTC.';
    expect(redactSecrets(text, ['some-unrelated-secret'])).toBe(text);
  });
});
