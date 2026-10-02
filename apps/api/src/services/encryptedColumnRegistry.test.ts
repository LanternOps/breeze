import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(),
}));

import {
  columnAad,
  encryptedColumnRegistry,
  encryptColumnValueForWrite,
  reencryptRegisteredSecrets,
  transformEncryptedColumnValue,
} from './encryptedColumnRegistry';
import { decryptForColumn, decryptSecret, encryptSecret } from './secretCrypto';
import { decryptNotificationChannelConfig } from './notificationChannelSecrets';

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

  it('never overwrites a value that changed after it was read (compare-and-set), counting it as contended', async () => {
    setEncryptionEnv({ APP_ENCRYPTION_KEY: 'current-key-material', APP_ENCRYPTION_KEY_ID: 'current' });
    const rowId = '44444444-4444-4444-8444-444444444444';
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialect = new PgDialect();
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const executor = {
      execute: vi.fn(async (query: any) => {
        const call = executor.execute.mock.calls.length;
        if (call === 1) return [{ present: true }];
        if (call === 2) return [{ id: rowId, value: { bucket: 'b', password: 'plaintext-secret' } }];
        if (call === 3) {
          updates.push(dialect.sqlToQuery(query));
          return []; // a concurrent save changed the row: the compare matched nothing
        }
        return [];
      }),
    };

    const stats = await reencryptRegisteredSecrets({
      dryRun: false,
      executor,
      registry: [{ table: 'backup_configs', column: 'provider_config', kind: 'json', description: 'test' }],
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toMatch(/"provider_config" = \$\d+::jsonb/);
    expect(updates[0]!.params).toContain(JSON.stringify({ bucket: 'b', password: 'plaintext-secret' }));
    expect(stats.changed).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.contended).toBe(1);
    expect(stats.errors).toEqual([]);
  });

  describe('moved column keeps its AAD tag (#6379)', () => {
    it('notification channel config is registered on notification_channel_configs under the old notification_channels.config tag', () => {
      const spec = encryptedColumnRegistry.find((s) => s.table === 'notification_channel_configs' && s.column === 'config');
      expect(spec).toBeDefined();
      expect(spec!.idColumn).toBe('channel_id');
      expect(columnAad(spec!)).toBe('notification_channels.config');
      // Contract step (#7028): the legacy notification_channels.config column is
      // dropped, so the key-rotation walker must no longer target it (an entry
      // would fail with 42703 at rotation time).
      const legacy = encryptedColumnRegistry.filter((s) => s.table === 'notification_channels');
      expect(legacy).toEqual([]);
    });

    it('a value rotated by the walker under the moved spec decrypts on the read path', () => {
      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
      });
      const previous = process.env.ENABLE_AAD_V3;
      process.env.ENABLE_AAD_V3 = 'true';
      try {
        const spec = encryptedColumnRegistry.find((s) => s.table === 'notification_channel_configs')!;
        const rotated = transformEncryptedColumnValue(spec, { webhookUrl: 'https://hooks.slack.example/s3cret' }, 'channel-1') as {
          webhookUrl: string;
        };
        expect(rotated.webhookUrl).toMatch(/^enc:v3:current:/);
        // The read path (notificationChannelSecrets) decrypts under the old tag.
        expect(decryptForColumn('notification_channels', 'config', rotated.webhookUrl)).toBe('https://hooks.slack.example/s3cret');
        expect(decryptNotificationChannelConfig('slack', rotated)).toEqual({ webhookUrl: 'https://hooks.slack.example/s3cret' });
      } finally {
        if (previous === undefined) delete process.env.ENABLE_AAD_V3;
        else process.env.ENABLE_AAD_V3 = previous;
      }
    });
  });

  describe('partner AI connections keep the legacy partner_llm_configs AAD tag (#7600 W02)', () => {
    const legacySpec = () => encryptedColumnRegistry.find((s) => s.table === 'partner_llm_configs' && s.column === 'api_key_encrypted')!;
    const connectionSpec = () => encryptedColumnRegistry.find((s) => s.table === 'partner_ai_connections' && s.column === 'api_key_encrypted')!;
    const rowId = '22222222-2222-4222-8222-222222222222';

    it('is registered row-bound under the legacy tag', () => {
      expect(connectionSpec()).toMatchObject({ kind: 'text', aadBinding: 'row', aadTag: 'partner_llm_configs.api_key_encrypted' });
      expect(columnAad(connectionSpec(), rowId)).toBe(`partner_llm_configs.api_key_encrypted:${rowId}`);
      expect(columnAad(connectionSpec(), rowId)).toBe(columnAad(legacySpec(), rowId));
    });

    it('a legacy ciphertext decrypts under the connection spec for the same id, and only that id', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'current-key-material', APP_ENCRYPTION_KEY_ID: 'current' });
      const sealed = transformEncryptedColumnValue(legacySpec(), 'sk-ant-api03-legacy', rowId) as string;
      expect(decryptSecret(sealed, { aad: columnAad(connectionSpec(), rowId) })).toBe('sk-ant-api03-legacy');
      expect(() => decryptSecret(sealed, { aad: columnAad(connectionSpec(), '33333333-3333-4333-8333-333333333333') })).toThrow();
    });

    it('the rotation walker re-seals a connection key under the legacy tag + row id', async () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'old-key-material', APP_ENCRYPTION_KEY_ID: 'old' });
      const sealedOld = transformEncryptedColumnValue(legacySpec(), 'sk-ant-api03-rotate', rowId) as string;
      setEncryptionEnv({
        APP_ENCRYPTION_KEY: 'current-key-material',
        APP_ENCRYPTION_KEY_ID: 'current',
        APP_ENCRYPTION_KEYRING: JSON.stringify({ old: 'old-key-material', current: 'current-key-material' }),
      });
      const executor = {
        execute: vi.fn(async () => {
          const call = executor.execute.mock.calls.length;
          if (call === 1) return [{ present: true }];
          if (call === 2) return [{ id: rowId, value: sealedOld }];
          if (call === 3) return [{ updated: 1 }];
          return [];
        }),
      };
      const stats = await reencryptRegisteredSecrets({
        dryRun: false,
        executor,
        registry: [connectionSpec()],
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      expect(stats.errors).toEqual([]);
      expect(stats.updated).toBe(1);
      // Whatever the walker sealed decrypts under the connection spec for the same row.
      const resealed = transformEncryptedColumnValue(connectionSpec(), sealedOld, rowId) as string;
      expect(resealed).toMatch(/^enc:v3:current:/);
      expect(decryptSecret(resealed, { aad: columnAad(connectionSpec(), rowId) })).toBe('sk-ant-api03-rotate');
    });
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
            return [{ updated: 1 }];
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

  describe('notification settings secrets in partners/organizations.settings', () => {
    const SLACK = 'https://hooks.slack.example/services/T000/B000/abcdef';
    const EXTRA = 'https://hooks.example.com/incoming/abc?token=xyz';

    it.each(['partners', 'organizations'] as const)(
      'seals the Slack URL, Pushover credentials and extra webhook URLs in %s.settings.notifications',
      (table) => {
        setEncryptionEnv({ APP_ENCRYPTION_KEY: 'current-key-material', APP_ENCRYPTION_KEY_ID: 'current' });

        const sealed = encryptColumnValueForWrite(table, 'settings', {
          notifications: {
            slackWebhookUrl: SLACK,
            slackChannel: '#ops-alerts',
            pushoverAppToken: 'azGDORePK8gMaC0QOYAMyEEuzJnyUi',
            pushoverDefaultUser: 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG',
            pushoverDefaultSound: 'pushover',
            webhooks: [EXTRA, ''],
          },
        }) as { notifications: Record<string, unknown> };

        const n = sealed.notifications;
        expect(n.slackChannel).toBe('#ops-alerts');
        expect(n.pushoverDefaultSound).toBe('pushover');
        for (const field of ['slackWebhookUrl', 'pushoverAppToken', 'pushoverDefaultUser'] as const) {
          expect(n[field]).toMatch(/^enc:v2:current:/);
        }
        const webhooks = n.webhooks as string[];
        expect(webhooks[0]).toMatch(/^enc:v2:current:/);
        expect(webhooks[1]).toBe('');
        expect(JSON.stringify(sealed)).not.toContain('hooks.');
        expect(decryptForColumn(table, 'settings', n.slackWebhookUrl as string)).toBe(SLACK);
        expect(decryptForColumn(table, 'settings', webhooks[0])).toBe(EXTRA);
        expect(decryptForColumn(table, 'settings', n.pushoverAppToken as string)).toBe('azGDORePK8gMaC0QOYAMyEEuzJnyUi');
      },
    );

    it('treats `webhooks` as a secret only under notifications, not wherever the key appears', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'current-key-material', APP_ENCRYPTION_KEY_ID: 'current' });

      const value = {
        webhooks: ['webhook-id-1'],
        ticketing: { webhooks: ['ticket.created'] },
        monitoring: { webhooks: { enabled: true, endpoints: [{ id: 'e1', name: 'Ops' }] } },
      };
      expect(encryptColumnValueForWrite('partners', 'settings', value)).toEqual(value);
    });

    it('applies the settings paths only to the settings columns', () => {
      setEncryptionEnv({ APP_ENCRYPTION_KEY: 'current-key-material', APP_ENCRYPTION_KEY_ID: 'current' });

      const value = { notifications: { slackWebhookUrl: 'https://example.com/x', webhooks: ['https://example.com/y'] } };
      expect(encryptColumnValueForWrite('psa_connections', 'credentials', value)).toEqual(value);
    });
  });
});
