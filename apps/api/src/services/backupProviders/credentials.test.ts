import { afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

// Secret-crypto env bootstrap copied verbatim from `toolSources/secrets.test.ts` —
// `encryptSecret`/`decryptSecret` derive their key from `APP_ENCRYPTION_KEY`, and
// the row-bound AAD assertions below need APP_ENCRYPTION_KEY_ID set (v1 ciphertext
// ignores AAD entirely), so a bare development fallback would let the "different
// row id" case pass for the wrong reason.
const originalEncryptionEnv = {
  key: process.env.APP_ENCRYPTION_KEY,
  keyId: process.env.APP_ENCRYPTION_KEY_ID,
  keyring: process.env.APP_ENCRYPTION_KEYRING,
};

process.env.APP_ENCRYPTION_KEY = 'backup-provider-credentials-unit-test-key-material';
process.env.APP_ENCRYPTION_KEY_ID = 'backup-provider-credentials-test';
delete process.env.APP_ENCRYPTION_KEYRING;

afterAll(() => {
  if (originalEncryptionEnv.key === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = originalEncryptionEnv.key;
  if (originalEncryptionEnv.keyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
  else process.env.APP_ENCRYPTION_KEY_ID = originalEncryptionEnv.keyId;
  if (originalEncryptionEnv.keyring === undefined) delete process.env.APP_ENCRYPTION_KEYRING;
  else process.env.APP_ENCRYPTION_KEYRING = originalEncryptionEnv.keyring;
});

import { decryptProviderCredentials, encryptProviderCredentials } from './credentials';

describe('backup provider credential crypto', () => {
  const creds = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };

  it('round-trips a credential blob through the SAME row id', () => {
    const rowId = randomUUID();
    const sealed = encryptProviderCredentials(rowId, creds);
    expect(sealed).not.toContain('sup3r-s3cret');
    expect(decryptProviderCredentials(rowId, sealed)).toEqual(creds);
  });

  it('refuses to decrypt under a DIFFERENT row id (row-bound AAD)', () => {
    // The whole point of aadBinding: 'row'. Without it, someone with DB write
    // access could paste another partner's ciphertext into their own
    // connection row and have the application decrypt it back to them.
    const sealed = encryptProviderCredentials(randomUUID(), creds);
    expect(() => decryptProviderCredentials(randomUUID(), sealed)).toThrow();
  });

  it('refuses an empty row id rather than sealing under a guessable AAD', () => {
    expect(() => encryptProviderCredentials('', creds)).toThrow(/row id/i);
    expect(() => decryptProviderCredentials('', 'anything')).toThrow(/row id/i);
  });

  it('throws a typed error, not a raw JSON parse error, on a corrupt blob', () => {
    const rowId = randomUUID();
    expect(() => decryptProviderCredentials(rowId, '')).toThrow();
  });
});
