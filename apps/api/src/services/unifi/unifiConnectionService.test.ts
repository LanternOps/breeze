import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as svc from './unifiConnectionService';
import { unifiIntegrationKeys, unifiIntegrations } from '../../db/schema';

vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));
vi.mock('../secretCrypto', () => ({
  encryptSecret: vi.fn(() => 'enc-key'),
  decryptSecret: vi.fn(() => null),
  decryptForColumn: vi.fn(() => null),
}));

// Minimal chainable db mock: each method returns an object exposing the next
function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => overrides.selectRows ?? [] }) }) })),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: () => overrides.insertRows ?? [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => overrides.updateRows ?? [] }) }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: () => overrides.deleteRows ?? [] }) })),
  } as unknown as svc.DbExecutor;
}

describe('unifiConnectionService', () => {
  it('markStatus throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markStatus(db, 'conn-1', 'partner-1', 'error', 'boom'))
      .rejects.toThrow(/no unifi_integrations row/i);
  });

  it('markStatus succeeds when a row is returned', async () => {
    const db = makeDb({ updateRows: [{ id: 'conn-1' }] });
    await expect(svc.markStatus(db, 'conn-1', 'partner-1', 'connected')).resolves.toBeUndefined();
  });

  it('markSynced throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markSynced(db, 'conn-1', 'partner-1', 'success'))
      .rejects.toThrow(/no unifi_integrations row/i);
  });

  it('deleteConnection returns false on 0 rows (idempotent) and true when a row is deleted', async () => {
    await expect(svc.deleteConnection(makeDb({ deleteRows: [] }), 'partner-1')).resolves.toBe(false);
    await expect(svc.deleteConnection(makeDb({ deleteRows: [{ id: 'conn-1' }] }), 'partner-1')).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// txDb: a fake DbExecutor that dispatches on TABLE OBJECT IDENTITY and records
// every write with whether it ran on the transaction handle.
//   select from unifiIntegrations    -> opts.integration ? [opts.integration] : []
//   select from unifiIntegrationKeys -> opts.keys ?? []
//   insert into unifiIntegrations    -> [opts.upserted]
//   insert/update/delete elsewhere   -> [{ id }]
// ---------------------------------------------------------------------------
type Op = { op: 'insert' | 'update' | 'delete'; table: unknown; values?: any; set?: any; conflict?: any; onTx: boolean };

function txDb(opts: { integration?: any; keys?: any[]; upserted?: any }) {
  const ops: Op[] = [];
  const locks: unknown[] = [];
  function handle(onTx: boolean): svc.DbExecutor {
    const select = () => {
      let table: unknown;
      const chain: any = {
        from(t: unknown) { table = t; return chain; },
        where() { return chain; },
        limit() { return chain; },
        orderBy() { return chain; },
        for(mode: string) { locks.push({ table, mode }); return chain; },
        then(res: any, rej: any) {
          const rows = table === unifiIntegrations ? (opts.integration ? [opts.integration] : [])
            : table === unifiIntegrationKeys ? (opts.keys ?? []) : [];
          return Promise.resolve(rows).then(res, rej);
        },
      };
      return chain;
    };
    const write = (op: Op['op']) => (table: unknown) => {
      const rec: Op = { op, table, onTx };
      const chain: any = {
        values(v: any) { rec.values = v; return chain; },
        set(v: any) { rec.set = v; return chain; },
        onConflictDoUpdate(c: any) { rec.conflict = c; return chain; },
        where() { return chain; },
        returning() { return chain; },
        then(res: any, rej: any) {
          ops.push(rec);
          const rows = op === 'insert' && table === unifiIntegrations ? [opts.upserted] : [{ id: 'row-1' }];
          return Promise.resolve(rows).then(res, rej);
        },
      };
      return chain;
    };
    return {
      select,
      insert: write('insert'),
      update: write('update'),
      delete: write('delete'),
      transaction: async (fn: any) => fn(handle(true)),
    } as unknown as svc.DbExecutor;
  }
  return { db: handle(false), ops, locks };
}

const UPSERTED = {
  id: 'int-1', partnerId: 'partner-1', connectionType: 'cloud',
  baseUrl: 'https://api.ui.com', accountLabel: null,
  isActive: true, status: 'connected',
  lastSyncAt: null, lastSyncStatus: null, lastSyncError: null,
};

describe('upsertConnection writes the key table (#11808 W1)', () => {
  it('upsertConnection still writes the legacy column', async () => {
    const { db, ops } = txDb({ upserted: UPSERTED });
    await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://api.ui.com', apiKey: 'abcd-1234' });
    const upsert = ops.find((o) => o.op === 'insert' && o.table === unifiIntegrations)!;
    expect(upsert.values.apiKeyEncrypted).toBe('enc-key');
    expect(upsert.conflict.set.apiKeyEncrypted).toBe('enc-key');
    expect(ops.every((o) => o.onTx)).toBe(true);
  });

  it('upsertConnection inserts the first key labelled Global when no label is given', async () => {
    const { db, ops } = txDb({ upserted: UPSERTED, keys: [] });
    await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://api.ui.com', apiKey: 'abcd-1234', createdBy: 'user-1' });
    const keyInsert = ops.find((o) => o.op === 'insert' && o.table === unifiIntegrationKeys)!;
    expect(keyInsert.values).toMatchObject({
      integrationId: 'int-1', partnerId: 'partner-1', label: 'Global', apiKeyEncrypted: 'enc-key',
      keyLast4: '1234', status: 'connected', createdBy: 'user-1',
    });
  });

  it('upsertConnection labels the first key with the trimmed account label, clamped to 100 characters', async () => {
    const { db, ops } = txDb({ upserted: UPSERTED, keys: [] });
    await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://api.ui.com', apiKey: 'k-1', accountLabel: `  ${'M'.repeat(150)} ` });
    const keyInsert = ops.find((o) => o.op === 'insert' && o.table === unifiIntegrationKeys)!;
    expect(keyInsert.values.label).toBe('M'.repeat(100));
  });

  it("upsertConnection replaces the single key's ciphertext on reconnect", async () => {
    const { db, ops } = txDb({ integration: { id: 'int-1' }, upserted: UPSERTED, keys: [{ id: 'key-1' }] });
    await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://api.ui.com', apiKey: 'zzzz-9876' });
    expect(ops.some((o) => o.op === 'insert' && o.table === unifiIntegrationKeys)).toBe(false);
    const keyUpdate = ops.find((o) => o.op === 'update' && o.table === unifiIntegrationKeys)!;
    expect(keyUpdate.set).toMatchObject({
      apiKeyEncrypted: 'enc-key', keyLast4: '9876', status: 'connected', lastSyncError: null, lastSeenHostIds: null,
    });
  });

  it('upsertConnection locks the active integration row before counting keys', async () => {
    const { db, locks } = txDb({ integration: { id: 'int-1' }, upserted: UPSERTED, keys: [{ id: 'key-1' }] });
    await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://api.ui.com', apiKey: 'k-1' });
    expect(locks[0]).toEqual({ table: unifiIntegrations, mode: 'update' });
  });

  it('upsertConnection throws UnifiMultiKeyError with two keys and writes nothing', async () => {
    const { db, ops } = txDb({ integration: { id: 'int-1' }, upserted: UPSERTED, keys: [{ id: 'key-1' }, { id: 'key-2' }] });
    const err = await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://other.example', apiKey: 'k-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(svc.UnifiMultiKeyError);
    expect(err.code).toBe('UNIFI_MULTI_KEY');
    expect(ops).toEqual([]);
  });
});

describe('createSelfHostedIntegration (#11808 W1)', () => {
  it("createSelfHostedIntegration deletes the connection's key rows", async () => {
    const { db, ops } = txDb({ upserted: { id: 'int-1', connectionType: 'self_hosted' } });
    await svc.createSelfHostedIntegration(db, 'partner-1', { accountLabel: null, createdBy: null });
    const del = ops.find((o) => o.op === 'delete')!;
    expect(del.table).toBe(unifiIntegrationKeys);
    expect(ops.every((o) => o.onTx)).toBe(true);
    expect(ops.findIndex((o) => o.op === 'delete')).toBeGreaterThan(ops.findIndex((o) => o.op === 'insert'));
  });
});

describe('upsertConnection (cloud path)', () => {
  it('onConflictDoUpdate set block includes connectionType: cloud', async () => {
    const { db, ops } = txDb({ upserted: UPSERTED });
    await svc.upsertConnection(db, 'partner-1', { baseUrl: 'https://api.ui.com', apiKey: 'k' });
    const upsert = ops.find((o) => o.op === 'insert' && o.table === unifiIntegrations)!;
    expect(upsert.conflict.set.connectionType).toBe('cloud');
  });
});
