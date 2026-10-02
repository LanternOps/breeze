import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_PROVIDER_CONFIG_COLUMN,
  BackupProviderConfigSealError,
  findCiphertextShapedValue,
  isSecretField,
  holdsUnsealedBackupProviderSecret,
  openBackupProviderConfig,
  sealBackupProviderConfig,
  sealStoredBackupProviderConfig,
} from './backupProviderConfigSealing';
import { encryptedColumnRegistry, transformEncryptedColumnValue } from './encryptedColumnRegistry';
import { decryptSecret, encryptSecret, getEncryptedSecretKeyId, isEncryptedSecret } from './secretCrypto';

const KEY_ENV = ['APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING', 'ENABLE_AAD_V3'] as const;
const savedEnv = Object.fromEntries(KEY_ENV.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of KEY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function useKeyring(activeKeyId: string, keys: Record<string, string>) {
  process.env.APP_ENCRYPTION_KEY_ID = activeKeyId;
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify(keys);
}

const S3 = {
  bucket: 'acme-backups',
  region: 'us-east-1',
  endpoint: 'https://s3.example.com',
  prefix: 'tenant-a/',
  accessKey: 'AKIAEXAMPLEACCESS',
  secretKey: 'plain-s3-secret-key',
  sessionToken: 'plain-session-token',
  encryption: { mode: 's3-sse-kms', kmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc' },
};

// Every credential field a provider config can carry (S3 legacy spelling,
// Azure, GCS as string and as object, B2) — the enumeration the sealing
// predicate must cover.
const LEGACY_PROVIDER_SECRETS: Array<[string, Record<string, unknown>, string[]]> = [
  ['s3 (AWS spelling)', { bucket: 'b', region: 'r', accessKeyId: 'AKIA-LEGACY', secretAccessKey: 'plain-legacy-secret' }, ['accessKeyId', 'secretAccessKey']],
  ['azure_blob', { accountName: 'acct', container: 'c', accountKey: 'plain-azure-key' }, ['accountKey']],
  ['azure_blob (agent alias)', { account: 'acct', containerName: 'c', key: 'plain-azure-alias-key', sasToken: 'plain-sas' }, ['key', 'sasToken']],
  ['google_cloud (string)', { bucket: 'g', credentialsJson: '{"private_key":"plain-gcs-pk"}' }, ['credentialsJson']],
  ['backblaze', { bucket: 'b2', keyId: 'key-id-1', applicationKey: 'plain-b2-app-key' }, ['applicationKey']],
  ['backblaze (agent alias)', { bucket: 'b2', keyID: 'key-id-2', appKey: 'plain-b2-alias' }, ['appKey']],
];

function expectSealed(value: unknown) {
  expect(typeof value).toBe('string');
  expect(isEncryptedSecret(value as string)).toBe(true);
}

describe('backup provider config sealing', () => {
  beforeEach(restoreEnv);
  afterEach(restoreEnv);

  it('seals the S3 credentials and leaves the destination settings readable', () => {
    const stored = sealBackupProviderConfig(S3) as Record<string, any>;

    expectSealed(stored.accessKey);
    expectSealed(stored.secretKey);
    expectSealed(stored.sessionToken);
    expect(stored.bucket).toBe(S3.bucket);
    expect(stored.region).toBe(S3.region);
    expect(stored.endpoint).toBe(S3.endpoint);
    expect(stored.prefix).toBe(S3.prefix);
    expect(stored.encryption).toEqual(S3.encryption);
    expect(JSON.stringify(stored)).not.toContain('plain-');
  });

  it('round-trips: opening the stored form returns exactly what was written', () => {
    expect(openBackupProviderConfig(sealBackupProviderConfig(S3))).toEqual(S3);
  });

  it.each(LEGACY_PROVIDER_SECRETS)('seals every credential field of %s', (_name, config, secretFields) => {
    const stored = sealBackupProviderConfig(config) as Record<string, unknown>;
    for (const field of secretFields) expectSealed(stored[field]);
    expect(JSON.stringify(stored)).not.toContain('plain-');
    expect(openBackupProviderConfig(stored)).toEqual(config);
  });

  it('seals every string inside a credentials object (GCS service-account key)', () => {
    const config = {
      bucket: 'g',
      credentials: { type: 'service_account', private_key: 'plain-pk', client_email: 'svc@example.com' },
    };
    const stored = sealBackupProviderConfig(config) as { credentials: Record<string, unknown> };
    expectSealed(stored.credentials.private_key);
    expectSealed(stored.credentials.client_email);
    expectSealed(stored.credentials.type);
    expect(openBackupProviderConfig(stored)).toEqual(config);
  });

  it('binds the ciphertext to backup_configs.provider_config', () => {
    process.env.ENABLE_AAD_V3 = 'true';
    useKeyring('k1', { k1: 'key-material-one-0123456789abcdef' });
    const stored = sealBackupProviderConfig(S3) as { secretKey: string; accessKey: string; bucket: string };
    expect(stored.secretKey.startsWith('enc:v3:k1:')).toBe(true);
    expect(() => decryptSecret(stored.secretKey, { aad: 'psa_connections.credentials' })).toThrow();
    expect(decryptSecret(stored.secretKey, { aad: 'backup_configs.provider_config' })).toBe(S3.secretKey);
  });

  it('passes a plaintext (not yet backfilled) config through unchanged on read', () => {
    expect(openBackupProviderConfig(S3)).toEqual(S3);
  });

  it('opens a row whose secrets are part plaintext, part sealed', () => {
    const mixed = { ...S3, secretKey: (sealBackupProviderConfig(S3) as Record<string, unknown>).secretKey };
    expect(openBackupProviderConfig(mixed)).toEqual(S3);
  });

  it('refuses to store a value that is already ciphertext-shaped', () => {
    const foreign = encryptSecret('someone-elses-secret', { aad: 'psa_connections.credentials' })!;
    expect(findCiphertextShapedValue({ ...S3, secretKey: foreign })).toBe('secretKey');
    expect(findCiphertextShapedValue({ ...S3, nested: { bucket: foreign } })).toBe('nested.bucket');
    expect(findCiphertextShapedValue(S3)).toBeNull();
    expect(() => sealBackupProviderConfig({ ...S3, secretKey: foreign })).toThrow(BackupProviderConfigSealError);
  });

  it('masks every field it seals: the general secret names are secret fields too', () => {
    const config = { bucket: 'b', routingKey: 'plain-rk', community: 'plain-community', authPassphrase: 'plain-pp' };
    const stored = sealBackupProviderConfig(config) as Record<string, unknown>;
    for (const [key, value] of Object.entries(stored)) {
      const sealed = typeof value === 'string' && isEncryptedSecret(value);
      expect({ key, masked: isSecretField(key) }).toEqual({ key, masked: sealed });
    }
  });

  describe('backfill transform', () => {
    it('reports plaintext secrets and seals them, keeping existing ciphertext byte-identical', () => {
      const alreadySealed = (sealBackupProviderConfig(S3) as Record<string, unknown>).secretKey as string;
      const mixed = { ...S3, secretKey: alreadySealed };

      expect(holdsUnsealedBackupProviderSecret(mixed)).toBe(true);
      const sealed = sealStoredBackupProviderConfig(mixed) as Record<string, unknown>;
      expect(sealed.secretKey).toBe(alreadySealed);
      expectSealed(sealed.accessKey);
      expectSealed(sealed.sessionToken);
      expect(holdsUnsealedBackupProviderSecret(sealed)).toBe(false);
      expect(openBackupProviderConfig(sealed)).toEqual(S3);
    });

    it('is a no-op on an already-sealed config', () => {
      const sealed = sealBackupProviderConfig(S3);
      expect(holdsUnsealedBackupProviderSecret(sealed)).toBe(false);
      expect(sealStoredBackupProviderConfig(sealed)).toEqual(sealed);
    });

    it('does not count empty secrets or non-secret settings as unsealed', () => {
      expect(holdsUnsealedBackupProviderSecret({ bucket: 'b', region: 'r', secretKey: '' })).toBe(false);
      expect(holdsUnsealedBackupProviderSecret({ path: '/srv/backups' })).toBe(false);
    });
  });

  describe('key rotation', () => {
    it('is registered, so the rotation walker re-seals it under the new key', () => {
      expect(encryptedColumnRegistry).toContain(BACKUP_PROVIDER_CONFIG_COLUMN);

      useKeyring('old', { old: 'old-key-material-0123456789abcdef' });
      const underOld = sealBackupProviderConfig(S3) as { secretKey: string; accessKey: string; bucket: string };
      expect(getEncryptedSecretKeyId(underOld.secretKey)).toBe('old');

      useKeyring('new', { old: 'old-key-material-0123456789abcdef', new: 'new-key-material-0123456789abcdef' });
      // Still readable while the old key is retained…
      expect(openBackupProviderConfig(underOld)).toEqual(S3);
      // …and the walker's transform moves every sealed value to the new key.
      const rotated = transformEncryptedColumnValue(BACKUP_PROVIDER_CONFIG_COLUMN, underOld) as { secretKey: string; accessKey: string; bucket: string };
      expect(getEncryptedSecretKeyId(rotated.secretKey)).toBe('new');
      expect(getEncryptedSecretKeyId(rotated.accessKey)).toBe('new');
      expect(rotated.bucket).toBe(S3.bucket);

      useKeyring('new', { new: 'new-key-material-0123456789abcdef' });
      expect(openBackupProviderConfig(rotated)).toEqual(S3);
    });
  });
});
