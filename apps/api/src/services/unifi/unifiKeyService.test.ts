import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));

import { unifiIntegrationKeys, unifiIntegrations } from '../../db/schema';
import { encryptSecret, decryptSecret } from '../secretCrypto';
import { countEnabledKeys, getSyncKeys, listKeys, openUnifiKey, recordKeyResults, sealUnifiKey } from './unifiKeyService';
import type { KeyRunResult } from './unifiSyncService';
import type { DbExecutor } from './unifiConnectionService';

const LEGACY_AAD = 'unifi_integrations.api_key_encrypted';
const ENV_KEYS = ['APP_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function seal(plain: string): string {
  return encryptSecret(plain, { aad: LEGACY_AAD })!;
}

// ---------------------------------------------------------------------------
// scriptedDb: a fake DbExecutor that dispatches on TABLE OBJECT IDENTITY.
//   select from unifiIntegrations     → opts.integration ? [opts.integration] : []
//   select from unifiIntegrationKeys  → opts.keys
//   update unifiIntegrationKeys       → recorded in `updates`, returns [{ id }]
// The selected field names and orderBy SQL of every select are recorded.
// ---------------------------------------------------------------------------
function scriptedDb(opts: { integration?: Record<string, unknown> | null; keys?: Array<Record<string, unknown>>; updateRows?: unknown[] }) {
  const selects: Array<{ table: unknown; fields: string[] | null; orderBy: string | null }> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown>; where?: unknown }> = [];
  const dialect = new PgDialect();

  function selectChain(fields: Record<string, unknown> | undefined) {
    const record = { table: undefined as unknown, fields: fields ? Object.keys(fields) : null, orderBy: null as string | null };
    selects.push(record);
    const rows = () => {
      if (record.table === unifiIntegrations) return opts.integration ? [opts.integration] : [];
      if (record.table === unifiIntegrationKeys) return opts.keys ?? [];
      return [];
    };
    const chain: any = {
      from(table: unknown) { record.table = table; return chain; },
      where() { return chain; },
      orderBy(...args: any[]) {
        record.orderBy = dialect.sqlToQuery(sql.join(args, sql`, `)).sql;
        return chain;
      },
      limit() { return chain; },
      for() { return chain; },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve(rows()).then(resolve, reject);
      },
    };
    return chain;
  }

  function updateChain(table: unknown) {
    const record = { table, set: {} as Record<string, unknown>, where: undefined as unknown };
    const chain: any = {
      set(v: Record<string, unknown>) { record.set = v; return chain; },
      where(w: unknown) { record.where = w; return chain; },
      returning() { return chain; },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        updates.push(record);
        return Promise.resolve(opts.updateRows ?? [{ id: 'key-1' }]).then(resolve, reject);
      },
    };
    return chain;
  }

  const db = {
    select: (fields?: Record<string, unknown>) => selectChain(fields),
    insert: () => { throw new Error('unexpected insert'); },
    update: (table: unknown) => updateChain(table),
    delete: () => { throw new Error('unexpected delete'); },
    transaction: async <T>(fn: (tx: DbExecutor) => Promise<T>) => fn(db as unknown as DbExecutor),
  };
  return { db: db as unknown as DbExecutor, selects, updates };
}

const CLOUD = { id: 'int-1', partnerId: 'p-1', baseUrl: 'https://api.ui.com', connectionType: 'cloud', apiKeyEncrypted: null as string | null };

function keyRow(over: Record<string, unknown>) {
  return {
    id: 'key-1', label: 'Global', apiKeyEncrypted: seal('k-1'), keyLast4: null, isEnabled: true, lastSeenHostIds: null,
    ...over,
  };
}

describe('unifiKeyService', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = 'unifi-key-service-test-material-32-chars!!';
    process.env.APP_ENCRYPTION_KEY_ID = 'test';
    delete process.env.APP_ENCRYPTION_KEYRING;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    warn.mockRestore();
    log.mockRestore();
  });

  it('sealUnifiKey output opens with the legacy AAD', () => {
    const sealed = sealUnifiKey('site-manager-key');
    expect(sealed).toMatch(/^enc:v3:test:/);
    expect(decryptSecret(sealed, { aad: LEGACY_AAD })).toBe('site-manager-key');
    expect(openUnifiKey(sealed)).toBe('site-manager-key');
  });

  it('listKeys never selects api_key_encrypted', async () => {
    const { db, selects } = scriptedDb({
      keys: [{ id: 'key-1', label: 'Global', keyLast4: null, isEnabled: true, status: 'connected', createdAt: new Date() }],
    });
    const keys = await listKeys(db, 'int-1', 'p-1');
    expect(keys).toHaveLength(1);
    const keySelect = selects.find((s) => s.table === unifiIntegrationKeys)!;
    expect(keySelect.fields).not.toBeNull();
    expect(keySelect.fields).not.toContain('apiKeyEncrypted');
    expect(keySelect.orderBy).toBe('"unifi_integration_keys"."created_at" asc, "unifi_integration_keys"."id" asc');
    expect(keys[0]).not.toHaveProperty('apiKeyEncrypted');
  });

  it('getSyncKeys returns enabled keys in created_at,id order, decrypted', async () => {
    const { db, selects } = scriptedDb({
      integration: CLOUD,
      keys: [
        keyRow({ id: 'key-a', label: 'Independent', apiKeyEncrypted: seal('k-a'), keyLast4: 'ab12', lastSeenHostIds: ['h1'] }),
        keyRow({ id: 'key-off', label: 'Disabled', apiKeyEncrypted: seal('k-off'), isEnabled: false }),
        keyRow({ id: 'key-b', label: 'Fabric', apiKeyEncrypted: seal('k-b') }),
      ],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result).toEqual({
      baseUrl: 'https://api.ui.com',
      keys: [
        { id: 'key-a', label: 'Independent', apiKey: 'k-a', keyLast4: 'ab12', lastSeenHostIds: ['h1'] },
        { id: 'key-b', label: 'Fabric', apiKey: 'k-b', keyLast4: null, lastSeenHostIds: null },
      ],
    });
    const keySelect = selects.find((s) => s.table === unifiIntegrationKeys)!;
    expect(keySelect.orderBy).toBe('"unifi_integration_keys"."created_at" asc, "unifi_integration_keys"."id" asc');
  });

  it('getSyncKeys returns null for a self-hosted integration', async () => {
    const { db } = scriptedDb({ integration: { ...CLOUD, connectionType: 'self_hosted' }, keys: [keyRow({})] });
    await expect(getSyncKeys(db, 'int-1', 'p-1')).resolves.toBeNull();
  });

  it('getSyncKeys returns null when no active integration matches', async () => {
    const { db } = scriptedDb({ integration: null, keys: [keyRow({})] });
    await expect(getSyncKeys(db, 'int-1', 'p-1')).resolves.toBeNull();
  });

  it('getSyncKeys returns an undecryptable key as a decryptError entry, not omitted', async () => {
    const { db } = scriptedDb({
      integration: CLOUD,
      keys: [keyRow({ id: 'key-a', apiKeyEncrypted: seal('k-a') }), keyRow({ id: 'key-bad', label: 'Broken', apiKeyEncrypted: 'enc:v3:test:not-a-real-payload' })],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result!.keys).toHaveLength(2);
    expect(result!.keys[1]).toMatchObject({ id: 'key-bad', label: 'Broken', apiKey: null });
    const bad = result!.keys[1] as { decryptError: string };
    expect(bad.decryptError).toBe('The stored API key could not be decrypted');
  });

  it('getSyncKeys adopts a newer legacy key when the connection has one key', async () => {
    const legacy = seal('new');
    const { db, updates } = scriptedDb({
      integration: { ...CLOUD, apiKeyEncrypted: legacy },
      keys: [keyRow({ apiKeyEncrypted: seal('old'), keyLast4: '0old' })],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result!.keys).toEqual([{ id: 'key-1', label: 'Global', apiKey: 'new', keyLast4: null, lastSeenHostIds: null }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe(unifiIntegrationKeys);
    expect(updates[0]!.set).toMatchObject({ apiKeyEncrypted: legacy, keyLast4: null });
    expect(log).toHaveBeenCalledWith('[unifi] adopted a reconnect written by an older API instance', { integrationId: 'int-1' });
  });

  it('getSyncKeys adopts a readable legacy key over an unreadable key row (self-heal, not a decryptError)', async () => {
    const legacy = seal('legacy-good');
    const { db, updates } = scriptedDb({
      integration: { ...CLOUD, apiKeyEncrypted: legacy },
      keys: [keyRow({ apiKeyEncrypted: 'enc:v3:test:corrupt-row' })],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result!.keys).toEqual([{ id: 'key-1', label: 'Global', apiKey: 'legacy-good', keyLast4: null, lastSeenHostIds: null }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toMatchObject({ apiKeyEncrypted: legacy });
  });

  it('getSyncKeys keeps the key row when the adoption write matches no row', async () => {
    const { db, updates } = scriptedDb({
      integration: { ...CLOUD, apiKeyEncrypted: seal('new') },
      keys: [keyRow({ apiKeyEncrypted: seal('old') })],
      updateRows: [],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(updates).toHaveLength(1);
    expect(result!.keys[0]).toMatchObject({ apiKey: 'old' });
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[unifi] legacy key adoption matched no key row; not adopted', { integrationId: 'int-1' });
  });

  it('getSyncKeys does not write when the legacy plaintext matches the key row', async () => {
    const { db, updates } = scriptedDb({
      integration: { ...CLOUD, apiKeyEncrypted: seal('same') },
      keys: [keyRow({ apiKeyEncrypted: seal('same') })],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result!.keys[0]).toMatchObject({ apiKey: 'same' });
    expect(updates).toHaveLength(0);
  });

  it('getSyncKeys does not adopt an undecryptable legacy value and returns the key row as an ok key', async () => {
    const { db, updates } = scriptedDb({
      integration: { ...CLOUD, apiKeyEncrypted: 'enc:v3:test:garbage-legacy' },
      keys: [keyRow({ apiKeyEncrypted: seal('row-key') })],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result!.keys).toEqual([{ id: 'key-1', label: 'Global', apiKey: 'row-key', keyLast4: null, lastSeenHostIds: null }]);
    expect(result!.keys[0]).not.toHaveProperty('decryptError');
    expect(updates).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('[unifi] legacy key unreadable; not adopted', { integrationId: 'int-1' });
  });

  it('getSyncKeys never consults the legacy column when the connection has two keys', async () => {
    const { db, updates } = scriptedDb({
      integration: { ...CLOUD, apiKeyEncrypted: seal('legacy-different') },
      keys: [keyRow({ id: 'key-a', apiKeyEncrypted: seal('k-a') }), keyRow({ id: 'key-b', label: 'Fabric', apiKeyEncrypted: seal('k-b') })],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result!.keys.map((k) => k.apiKey)).toEqual(['k-a', 'k-b']);
    expect(updates).toHaveLength(0);
  });
});

describe('recordKeyResults (#11808 W2)', () => {
  const dialect = new PgDialect();
  const render = (frag: unknown) => dialect.sqlToQuery(frag as any);
  const RUN_STARTED = new Date('2026-11-22T10:00:00Z');
  const result = (over: Partial<KeyRunResult>): KeyRunResult => ({
    keyId: 'key-1', label: 'Global', status: 'success', authFailure: false,
    hostsSeen: 2, sitesSeen: 3, hostIds: ['h1', 'h2'], error: null, ...over,
  });
  const record = (db: DbExecutor, results: KeyRunResult[], keyLast4ById = new Map<string, string>()) =>
    recordKeyResults(db, { integrationId: 'int-1', partnerId: 'p-1', runStartedAt: RUN_STARTED, results, keyLast4ById });

  it('recordKeyResults skips a key deleted mid-run', async () => {
    const { db, updates } = scriptedDb({ updateRows: [] });
    await expect(record(db, [result({}), result({ keyId: 'key-2', status: 'failed', error: 'boom', hostIds: null })])).resolves.toBeUndefined();
    expect(updates).toHaveLength(2);
  });

  it("recordKeyResults never overwrites a newer run's result", async () => {
    const { db, updates } = scriptedDb({});
    await record(db, [result({})]);
    const where = render(updates[0]!.where);
    expect(where.sql).toContain('"unifi_integration_keys"."id" = $');
    expect(where.sql).toContain('"unifi_integration_keys"."integration_id" = $');
    expect(where.sql).toContain('"unifi_integration_keys"."partner_id" = $');
    expect(where.sql).toMatch(/\("unifi_integration_keys"\."last_sync_at" is null or "unifi_integration_keys"\."last_sync_at" < \$\d+\)/);
    expect(where.params).toEqual(expect.arrayContaining(['key-1', 'int-1', 'p-1', RUN_STARTED.toISOString()]));
    expect(updates[0]!.set.lastSyncAt).toEqual(RUN_STARTED);
  });

  it('recordKeyResults fills key_last4 only when null', async () => {
    const { db, updates } = scriptedDb({});
    await record(db, [result({}), result({ keyId: 'key-2' })], new Map([['key-1', 'wxyz']]));
    const last4 = render(updates[0]!.set.keyLast4);
    expect(last4.sql).toBe('coalesce("unifi_integration_keys"."key_last4", $1)');
    expect(last4.params).toEqual(['wxyz']);
    // No candidate for key-2: its key_last4 is not touched at all.
    expect(updates[1]!.set).not.toHaveProperty('keyLast4');
  });

  it('a success writes connected, the counts and the reach snapshot', async () => {
    const { db, updates } = scriptedDb({});
    await record(db, [result({})]);
    expect(updates[0]!.set).toMatchObject({
      status: 'connected', lastSyncStatus: 'success', lastSyncError: null,
      hostsSeen: 2, sitesSeen: 3, lastSeenHostIds: ['h1', 'h2'],
    });
    expect(updates[0]!.set.lastOkAt).toBeInstanceOf(Date);
  });

  it('a hosts-only success keeps the snapshot and site count', async () => {
    const { db, updates } = scriptedDb({});
    await record(db, [result({ sitesSeen: null, hostIds: null })]);
    expect(updates[0]!.set).not.toHaveProperty('lastSeenHostIds');
    expect(updates[0]!.set).not.toHaveProperty('sitesSeen');
    expect(updates[0]!.set.hostsSeen).toBe(2);
  });

  it('a failure records reauth_required for an auth failure, error otherwise, and keeps the snapshot', async () => {
    const { db, updates } = scriptedDb({});
    await record(db, [
      result({ status: 'failed', authFailure: true, error: 'nope', hostIds: null }),
      result({ keyId: 'key-2', status: 'failed', error: 'x'.repeat(900), hostIds: null }),
    ]);
    expect(updates[0]!.set).toMatchObject({ status: 'reauth_required', lastSyncStatus: 'failed', lastSyncError: 'nope' });
    expect(updates[1]!.set).toMatchObject({ status: 'error', lastSyncStatus: 'failed' });
    expect((updates[1]!.set.lastSyncError as string).length).toBe(500);
    for (const u of updates) {
      expect(u.set).not.toHaveProperty('lastSeenHostIds');
      expect(u.set).not.toHaveProperty('lastOkAt');
    }
  });

  it('a skipped key records skipped and leaves its status alone', async () => {
    const { db, updates } = scriptedDb({});
    await record(db, [result({ status: 'skipped', error: 'sync time budget exhausted', hostIds: null })]);
    expect(updates[0]!.set).toMatchObject({ lastSyncStatus: 'skipped', lastSyncError: 'sync time budget exhausted' });
    expect(updates[0]!.set).not.toHaveProperty('status');
  });

  it('countEnabledKeys counts the enabled keys of the connection', async () => {
    const { db } = scriptedDb({ keys: [{ n: 2 }] });
    await expect(countEnabledKeys(db, 'int-1', 'p-1')).resolves.toBe(2);
  });
});
