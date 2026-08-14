import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(),
}));

import {
  columnAad,
  encryptColumnValueForWrite,
  reencryptRegisteredSecrets,
  transformEncryptedColumnValue,
} from './encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from './secretCrypto';

const ENV_KEYS = [
  'APP_ENCRYPTION_KEY',
  'APP_ENCRYPTION_KEY_ID',
  'APP_ENCRYPTION_KEYRING',
  'JWT_SECRET',
  'SESSION_SECRET',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function setEncryptionEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
}

describe('encryptedColumnRegistry', () => {
  beforeEach(() => {
    setEncryptionEnv();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('transforms text columns from legacy ciphertext to the active v2 key id', () => {
    setEncryptionEnv({ APP_ENCRYPTION_KEY: 'legacy-key-material' });
    const legacyCiphertext = encryptSecret('legacy-secret');

    setEncryptionEnv({
      APP_ENCRYPTION_KEY: 'legacy-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ current: 'current-key-material' }),
    });

    const transformed = transformEncryptedColumnValue({
      table: 'sso_providers',
      column: 'client_secret',
      kind: 'text',
      description: 'test',
    }, legacyCiphertext);

    expect(transformed).toMatch(/^enc:v2:current:/);
    expect(decryptSecret(transformed as string)).toBe('legacy-secret');
  });

  it('recursively rotates encrypted JSON values without changing non-secret plaintext', () => {
    setEncryptionEnv({
      APP_ENCRYPTION_KEY: 'old-key-material',
      APP_ENCRYPTION_KEY_ID: 'old',
    });
    const oldCiphertext = encryptSecret('old-token');

    setEncryptionEnv({
      APP_ENCRYPTION_KEY: 'current-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
      APP_ENCRYPTION_KEYRING: JSON.stringify({ old: 'old-key-material' }),
    });

    const transformed = transformEncryptedColumnValue({
      table: 'notification_channels',
      column: 'config',
      kind: 'json',
      description: 'test',
    }, {
      label: 'do-not-encrypt',
      nested: { authToken: oldCiphertext },
    }) as { label: string; nested: { authToken: string } };

    expect(transformed.label).toBe('do-not-encrypt');
    expect(transformed.nested.authToken).toMatch(/^enc:v2:current:/);
    expect(decryptSecret(transformed.nested.authToken)).toBe('old-token');
  });

  describe('first encryption with no APP_ENCRYPTION_KEY_ID (the shipped default)', () => {
    // Every other case in this file sets APP_ENCRYPTION_KEY_ID, which is why
    // this path went uncovered: plaintext was routed through reencryptSecret,
    // whose missing-key-id guard throws and fails the write.

    it('seals a plaintext text column to v1 instead of throwing', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'legacy-key-material' });

      const transformed = transformEncryptedColumnValue({
        table: 'device_recovery_keys',
        column: 'encrypted_key',
        kind: 'text',
        description: 'test',
      }, 'plaintext-recovery-key');

      expect(transformed).toMatch(/^enc:v1:/);
      expect(decryptSecret(transformed as string)).toBe('plaintext-recovery-key');
    });

    it('seals a plaintext JSON secret field to v1 and leaves non-secrets alone', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'legacy-key-material' });

      const transformed = transformEncryptedColumnValue({
        table: 'notification_channels',
        column: 'config',
        kind: 'json',
        description: 'test',
      }, {
        label: 'do-not-encrypt',
        nested: { apiKey: 'plaintext-api-key' },
      }) as { label: string; nested: { apiKey: string } };

      expect(transformed.label).toBe('do-not-encrypt');
      expect(transformed.nested.apiKey).toMatch(/^enc:v1:/);
      expect(decryptSecret(transformed.nested.apiKey)).toBe('plaintext-api-key');
    });

    it('seals plaintext entries of a text-array column to v1', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'legacy-key-material' });

      const transformed = transformEncryptedColumnValue({
        table: 'discovery_profiles',
        column: 'snmp_communities',
        kind: 'text-array',
        description: 'test',
      }, ['public', 'private']) as string[];

      expect(transformed).toHaveLength(2);
      for (const entry of transformed) {
        expect(entry).toMatch(/^enc:v1:/);
      }
      expect(transformed.map((e) => decryptSecret(e))).toEqual(['public', 'private']);
    });

    it('still rotates to the active key id when one IS configured', () => {
      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const transformed = transformEncryptedColumnValue({
        table: 'device_recovery_keys',
        column: 'encrypted_key',
        kind: 'text',
        description: 'test',
      }, 'plaintext-recovery-key');

      expect(transformed).toMatch(/^enc:v2:current:/);
      expect(decryptSecret(transformed as string)).toBe('plaintext-recovery-key');
    });

    it('leaves existing ciphertext untouched when no key id is configured', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'legacy-key-material' });
      const existing = encryptSecret('already-sealed');

      const transformed = transformEncryptedColumnValue({
        table: 'device_recovery_keys',
        column: 'encrypted_key',
        kind: 'text',
        description: 'test',
      }, existing);

      expect(transformed).toBe(existing);
    });
  });

  it('supports dry-run batch stats without writing updates', async () => {
    setEncryptionEnv({
      APP_ENCRYPTION_KEY: 'current-key-material',
      APP_ENCRYPTION_KEY_ID: 'current',
    });
    const executor = {
      execute: vi.fn(async () => {
        const call = executor.execute.mock.calls.length;
        if (call === 1) return [{ present: true }];
        if (call === 2) return [{ id: '11111111-1111-1111-1111-111111111111', value: 'plaintext-secret' }];
        return [];
      }),
    };

    const stats = await reencryptRegisteredSecrets({
      dryRun: true,
      executor,
      registry: [{ table: 'webhooks', column: 'secret', kind: 'text', description: 'test' }],
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(stats.scanned).toBe(1);
    expect(stats.changed).toBe(1);
    expect(stats.updated).toBe(0);
    expect(executor.execute).toHaveBeenCalledTimes(3);
  });

  describe('row-bound AAD (#3409)', () => {
    const rowSpec = {
      table: 'tenant_variables',
      column: 'value',
      kind: 'text' as const,
      aadBinding: 'row' as const,
      description: 'test',
    };

    it('columnAad appends the row id for row-bound specs only', () => {
      expect(columnAad(rowSpec, 'row-1')).toBe('tenant_variables.value:row-1');
      expect(columnAad({ ...rowSpec, aadBinding: 'column' }, 'row-1')).toBe('tenant_variables.value');
      expect(columnAad({ table: 'webhooks', column: 'secret', kind: 'text', description: 't' })).toBe('webhooks.secret');
    });

    it('refuses to derive an AAD for a row-bound spec without a row id', () => {
      expect(() => columnAad(rowSpec)).toThrow(/row id/i);
      expect(() => transformEncryptedColumnValue(rowSpec, 'plaintext')).toThrow(/row id/i);
    });

    it('encryptColumnValueForWrite refuses registered row-bound columns', () => {
      // Sealing without the row id would produce a value nothing can decrypt.
      expect(() => encryptColumnValueForWrite('tenant_variables', 'value', 'plaintext')).toThrow(/row id/i);
    });

    it('binds the ciphertext to its row: another row id cannot decrypt it', () => {
      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });

      const sealed = transformEncryptedColumnValue(rowSpec, 'super-secret', 'row-1') as string;
      expect(sealed).toMatch(/^enc:v3:current:/);
      expect(decryptSecret(sealed, { aad: columnAad(rowSpec, 'row-1') })).toBe('super-secret');
      expect(() => decryptSecret(sealed, { aad: columnAad(rowSpec, 'row-2') })).toThrow();
    });

    it('applies the binding without ENABLE_AAD_V3 — the flag day only governs pre-existing v2 columns', () => {
      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });
      delete process.env.ENABLE_AAD_V3;

      const sealed = transformEncryptedColumnValue(rowSpec, 'super-secret', 'row-1') as string;
      expect(sealed).toMatch(/^enc:v3:/);

      // A column-bound spec in the same configuration stays v2.
      const columnBound = transformEncryptedColumnValue(
        { table: 'webhooks', column: 'secret', kind: 'text', description: 'test' },
        'super-secret',
      ) as string;
      expect(columnBound).toMatch(/^enc:v2:/);
    });

    it('the rotation walker rebuilds the row binding instead of corrupting it', async () => {
      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'old-key-material',
        APP_ENCRYPTION_KEY_ID: 'old',
      });
      const rowId = '11111111-1111-1111-1111-111111111111';
      const sealedUnderOldKey = transformEncryptedColumnValue(rowSpec, 'super-secret', rowId) as string;

      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
        APP_ENCRYPTION_KEYRING: JSON.stringify({ old: 'old-key-material', current: 'current-key-material' }),
      });

      const updates: unknown[] = [];
      const executor = {
        execute: vi.fn(async (query: unknown) => {
          const call = executor.execute.mock.calls.length;
          if (call === 1) return [{ present: true }];
          if (call === 2) return [{ id: rowId, value: sealedUnderOldKey }];
          if (call === 3) {
            updates.push(query);
            return [];
          }
          return [];
        }),
      };

      const stats = await reencryptRegisteredSecrets({
        dryRun: false,
        executor,
        registry: [rowSpec],
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(stats.errors).toEqual([]);
      expect(stats.updated).toBe(1);
      expect(updates).toHaveLength(1);
    });
  });
});
