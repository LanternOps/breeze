import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));

import { unifiIntegrationKeys, unifiIntegrations } from '../../db/schema';
import { encryptSecret, decryptSecret } from '../secretCrypto';
import { addKey, countEnabledKeys, deleteKey, getSyncKeys, listKeys, openUnifiKey, recordKeyResults, sealUnifiKey, UNIFI_MAX_KEYS, updateKey } from './unifiKeyService';
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
    // Logged for the operator by key id only: never the ciphertext or the error text.
    expect(warn).toHaveBeenCalledWith('[unifi] a stored API key did not decrypt', { keyId: 'key-bad' });
  });

  it('getSyncKeys no longer adopts the legacy column (W3: the key row is the only source)', async () => {
    const { db, updates, selects } = scriptedDb({
      integration: { ...CLOUD, apiKeyEncrypted: seal('legacy-different') },
      keys: [keyRow({ apiKeyEncrypted: seal('row-key') })],
    });
    const result = await getSyncKeys(db, 'int-1', 'p-1');
    expect(result!.keys).toEqual([{ id: 'key-1', label: 'Global', apiKey: 'row-key', keyLast4: null, lastSeenHostIds: null }]);
    expect(updates).toHaveLength(0);
    const integrationSelect = selects.find((s) => s.table === unifiIntegrations)!;
    expect(integrationSelect.fields).not.toContain('apiKeyEncrypted');
    expect(log).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Key CRUD (#11808 W3). crudDb is a fake DbExecutor that logs every statement
// in order and dispatches selects on the selected field names:
//   unifiIntegrations + .for('update')        → 'lock'        → opts.integration
//   unifiIntegrationKeys {id,label,isEnabled} → 'keys'        → opts.keys
//   unifiIntegrationKeys {id} (label probe)   → 'label-check' → opts.labelTaken ? [{id}] : []
//   unifiIntegrationKeys {apiKeyEncrypted}    → 'first-key'   → the first of opts.keys
// ---------------------------------------------------------------------------
type CrudKey = { id: string; label: string; isEnabled: boolean; apiKeyEncrypted?: string };
function crudDb(opts: {
  integration?: { id: string; connectionType: string } | null;
  keys?: CrudKey[];
  labelTaken?: boolean;
  insertError?: unknown;
}) {
  const ops: string[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];
  const deletes: unknown[] = [];
  const keys = opts.keys ?? [];
  const summary = (over: Record<string, unknown>) => ({
    id: 'key-new', label: 'x', keyLast4: null, isEnabled: true, status: 'pending', lastSyncAt: null, lastSyncStatus: null,
    lastSyncError: null, lastOkAt: null, hostsSeen: null, sitesSeen: null, createdAt: new Date('2026-11-22T00:00:00Z'), ...over,
  });

  function selectChain(fields: Record<string, unknown> | undefined) {
    const names = fields ? Object.keys(fields) : [];
    let table: unknown;
    let locked = false;
    const rows = () => {
      if (table === unifiIntegrations) {
        ops.push(locked ? 'lock' : 'select-integration');
        return opts.integration ? [opts.integration] : [];
      }
      if (table === unifiIntegrationKeys) {
        if (names.length === 1 && names[0] === 'apiKeyEncrypted') {
          ops.push('first-key');
          return keys.length ? [{ apiKeyEncrypted: keys[0]!.apiKeyEncrypted ?? 'enc:first' }] : [];
        }
        if (names.length === 1 && names[0] === 'id') {
          ops.push('label-check');
          return opts.labelTaken ? [{ id: 'other' }] : [];
        }
        ops.push('keys');
        return keys.map(({ id, label, isEnabled }) => ({ id, label, isEnabled }));
      }
      return [];
    };
    const chain: any = {
      from(t: unknown) { table = t; return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      for(mode: string) { locked = mode === 'no key update'; return chain; },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return Promise.resolve().then(rows).then(resolve, reject);
      },
    };
    return chain;
  }

  const db: any = {
    select: (fields?: Record<string, unknown>) => selectChain(fields),
    insert: (table: unknown) => {
      let values: Record<string, unknown> = {};
      const chain: any = {
        values(v: Record<string, unknown>) { values = v; return chain; },
        returning() { return chain; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          ops.push('insert');
          inserts.push(values);
          if (opts.insertError) return Promise.reject(opts.insertError).then(resolve, reject);
          expect(table).toBe(unifiIntegrationKeys);
          return Promise.resolve([summary({ label: values.label, keyLast4: values.keyLast4 })]).then(resolve, reject);
        },
      };
      return chain;
    },
    update: (table: unknown) => {
      const record = { table, set: {} as Record<string, unknown> };
      const chain: any = {
        set(v: Record<string, unknown>) { record.set = v; return chain; },
        where() { return chain; },
        returning() { return chain; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          ops.push(table === unifiIntegrations ? 'mirror-legacy' : 'update-key');
          updates.push(record);
          return Promise.resolve([summary({ id: 'key-1', ...record.set })]).then(resolve, reject);
        },
      };
      return chain;
    },
    delete: (table: unknown) => {
      const chain: any = {
        where() { return chain; },
        returning() { return chain; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          ops.push('delete');
          deletes.push(table);
          return Promise.resolve([{ id: 'key-1' }]).then(resolve, reject);
        },
      };
      return chain;
    },
    transaction: async <T>(fn: (tx: DbExecutor) => Promise<T>) => {
      ops.push('begin');
      const out = await fn(db as DbExecutor);
      ops.push('commit');
      return out;
    },
  };
  return { db: db as DbExecutor, ops, inserts, updates, deletes };
}

const CLOUD_INT = { id: 'int-1', connectionType: 'cloud' };
const nKeys = (n: number, over: Partial<CrudKey> = {}): CrudKey[] =>
  Array.from({ length: n }, (_, i) => ({ id: `key-${i + 1}`, label: `Key ${i + 1}`, isEnabled: true, ...over }));
const ADD = { integrationId: 'int-1', partnerId: 'p-1', label: '  Macera  ', apiKey: 'sm-key-abcdWXYZ', seenHostIds: ['h1', 'h2'], createdBy: 'u-1' };

describe('key CRUD (#11808 W3)', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = 'unifi-key-service-test-material-32-chars!!';
    process.env.APP_ENCRYPTION_KEY_ID = 'test';
    delete process.env.APP_ENCRYPTION_KEYRING;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it('UNIFI_MAX_KEYS is 25', () => {
    expect(UNIFI_MAX_KEYS).toBe(25);
  });

  it('addKey locks the integration row before counting', async () => {
    const { db, ops, inserts } = crudDb({ integration: CLOUD_INT, keys: nKeys(1) });
    const key = await addKey(db, ADD);
    expect(ops.slice(0, 3)).toEqual(['begin', 'lock', 'keys']);
    expect(ops.indexOf('insert')).toBeGreaterThan(ops.indexOf('label-check'));
    expect(inserts[0]).toMatchObject({
      integrationId: 'int-1', partnerId: 'p-1', label: 'Macera', keyLast4: 'WXYZ', status: 'pending',
      lastSeenHostIds: ['h1', 'h2'], createdBy: 'u-1', isEnabled: true,
    });
    // Sealed with the legacy column AAD, never stored as plaintext.
    expect(inserts[0]!.apiKeyEncrypted).not.toContain('sm-key');
    expect(decryptSecret(inserts[0]!.apiKeyEncrypted as string, { aad: LEGACY_AAD })).toBe('sm-key-abcdWXYZ');
    expect(key).not.toHaveProperty('apiKeyEncrypted');
    expect(key.label).toBe('Macera');
  });

  it('addKey refuses the 26th key with UNIFI_KEY_LIMIT', async () => {
    const { db, ops } = crudDb({ integration: CLOUD_INT, keys: nKeys(25) });
    await expect(addKey(db, ADD)).rejects.toMatchObject({ name: 'UnifiKeyError', code: 'UNIFI_KEY_LIMIT' });
    expect(ops).not.toContain('insert');
  });

  it('addKey counts disabled keys toward the cap', async () => {
    const off = nKeys(24, { isEnabled: false }).map((k, i) => ({ ...k, id: `off-${i}`, label: `Off ${i}` }));
    const { db } = crudDb({ integration: CLOUD_INT, keys: [...nKeys(1), ...off] });
    await expect(addKey(db, ADD)).rejects.toMatchObject({ code: 'UNIFI_KEY_LIMIT' });
  });

  it('addKey refuses a label another key holds (checked under the lock)', async () => {
    const { db, ops } = crudDb({ integration: CLOUD_INT, keys: nKeys(1), labelTaken: true });
    await expect(addKey(db, ADD)).rejects.toMatchObject({ code: 'UNIFI_KEY_LABEL_TAKEN' });
    expect(ops).not.toContain('insert');
  });

  it('addKey maps 23505 to UNIFI_KEY_LABEL_TAKEN', async () => {
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "unifi_integration_keys_label_idx"'), {
      code: '23505', constraint_name: 'unifi_integration_keys_label_idx',
    });
    const { db } = crudDb({ integration: CLOUD_INT, keys: nKeys(1), insertError: pgErr });
    await expect(addKey(db, ADD)).rejects.toMatchObject({ name: 'UnifiKeyError', code: 'UNIFI_KEY_LABEL_TAKEN' });
  });

  it('addKey does not map an unrelated 23505', async () => {
    const pgErr = Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'unifi_integration_keys_pkey' });
    const { db } = crudDb({ integration: CLOUD_INT, keys: nKeys(1), insertError: pgErr });
    await expect(addKey(db, ADD)).rejects.toBe(pgErr);
  });

  it('addKey refuses a self-hosted integration', async () => {
    const { db, ops } = crudDb({ integration: { id: 'int-1', connectionType: 'self_hosted' }, keys: [] });
    await expect(addKey(db, ADD)).rejects.toMatchObject({ code: 'UNIFI_NOT_CLOUD' });
    expect(ops).not.toContain('insert');
  });

  it('addKey refuses when no active integration matches', async () => {
    const { db } = crudDb({ integration: null });
    await expect(addKey(db, ADD)).rejects.toMatchObject({ code: 'UNIFI_NOT_CONNECTED' });
  });

  it('addKey refuses a label that is empty after trimming', async () => {
    const { db, ops } = crudDb({ integration: CLOUD_INT, keys: nKeys(1) });
    await expect(addKey(db, { ...ADD, label: '   ' })).rejects.toThrow();
    expect(ops).not.toContain('insert');
  });

  it('updateKey refuses to disable the last enabled key', async () => {
    const { db, ops } = crudDb({ integration: CLOUD_INT, keys: [{ id: 'key-1', label: 'A', isEnabled: true }, { id: 'key-2', label: 'B', isEnabled: false }] });
    await expect(updateKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-1', isEnabled: false }))
      .rejects.toMatchObject({ code: 'UNIFI_LAST_ENABLED_KEY' });
    expect(ops).not.toContain('update-key');
    expect(ops.slice(0, 2)).toEqual(['begin', 'lock']);
  });

  it('updateKey disables a key while another stays enabled', async () => {
    const { db, updates } = crudDb({ integration: CLOUD_INT, keys: nKeys(2) });
    await updateKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-2', isEnabled: false });
    expect(updates.find((u) => u.table === unifiIntegrationKeys)!.set).toMatchObject({ isEnabled: false });
  });

  it('updateKey throws UNIFI_KEY_NOT_FOUND for an unknown key', async () => {
    const { db } = crudDb({ integration: CLOUD_INT, keys: nKeys(2) });
    await expect(updateKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'nope', label: 'X' }))
      .rejects.toMatchObject({ code: 'UNIFI_KEY_NOT_FOUND' });
  });

  it('updateKey renames with a trimmed label and refuses a taken one', async () => {
    const ok = crudDb({ integration: CLOUD_INT, keys: nKeys(2) });
    await updateKey(ok.db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-1', label: '  Fabric A ' });
    expect(ok.updates.find((u) => u.table === unifiIntegrationKeys)!.set).toMatchObject({ label: 'Fabric A' });
    expect(ok.ops).not.toContain('mirror-legacy');
    const taken = crudDb({ integration: CLOUD_INT, keys: nKeys(2), labelTaken: true });
    await expect(updateKey(taken.db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-1', label: 'Key 2' }))
      .rejects.toMatchObject({ code: 'UNIFI_KEY_LABEL_TAKEN' });
  });

  it('replacing a key resets status and stores the new host snapshot', async () => {
    const { db, updates, ops } = crudDb({ integration: CLOUD_INT, keys: nKeys(2) });
    await updateKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-2', apiKey: 'replacement-9876', seenHostIds: ['h9'] });
    const set = updates.find((u) => u.table === unifiIntegrationKeys)!.set;
    expect(set).toMatchObject({ keyLast4: '9876', status: 'pending', lastSyncError: null, lastSyncStatus: null, lastSeenHostIds: ['h9'] });
    // Fences off a sync already in flight with the old secret.
    expect(set.lastSyncAt).toBeInstanceOf(Date);
    expect(decryptSecret(set.apiKeyEncrypted as string, { aad: LEGACY_AAD })).toBe('replacement-9876');
    // The legacy column follows the first key (rollback to W1/W2 code, plan D12).
    expect(ops.indexOf('mirror-legacy')).toBeGreaterThan(ops.indexOf('update-key'));
  });

  it('replacing the sole key mirrors the first key ciphertext into the legacy column', async () => {
    const { db, updates } = crudDb({ integration: CLOUD_INT, keys: [{ id: 'key-1', label: 'Global', isEnabled: true, apiKeyEncrypted: 'enc:first-row' }] });
    await updateKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-1', apiKey: 'fresh-key-1111', seenHostIds: [] });
    const mirror = updates.find((u) => u.table === unifiIntegrations);
    expect(mirror!.set).toEqual({ apiKeyEncrypted: 'enc:first-row' });
  });

  it('deleteKey refuses the last key', async () => {
    const { db, ops } = crudDb({ integration: CLOUD_INT, keys: nKeys(1) });
    await expect(deleteKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-1' }))
      .rejects.toMatchObject({ code: 'UNIFI_LAST_ENABLED_KEY' });
    expect(ops).not.toContain('delete');
  });

  it('deleteKey refuses the only enabled key while disabled keys remain', async () => {
    const { db } = crudDb({ integration: CLOUD_INT, keys: [{ id: 'key-1', label: 'A', isEnabled: true }, { id: 'key-2', label: 'B', isEnabled: false }] });
    await expect(deleteKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-1' }))
      .rejects.toMatchObject({ code: 'UNIFI_LAST_ENABLED_KEY' });
  });

  it('deleteKey returns false for an unknown key', async () => {
    const { db, ops } = crudDb({ integration: CLOUD_INT, keys: nKeys(2) });
    await expect(deleteKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'gone' })).resolves.toBe(false);
    expect(ops).not.toContain('delete');
  });

  it('deleteKey removes a key and re-points the legacy column at the first remaining key', async () => {
    const { db, ops, deletes } = crudDb({ integration: CLOUD_INT, keys: nKeys(2) });
    await expect(deleteKey(db, { integrationId: 'int-1', partnerId: 'p-1', keyId: 'key-1' })).resolves.toBe(true);
    expect(deletes).toEqual([unifiIntegrationKeys]);
    expect(ops.slice(0, 2)).toEqual(['begin', 'lock']);
    expect(ops.indexOf('mirror-legacy')).toBeGreaterThan(ops.indexOf('delete'));
  });
});
