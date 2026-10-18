import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportJWK, generateKeyPair, type JWK } from 'jose';

const cryptoCalls: { encrypt: Array<{ aad?: string }>; decrypt: Array<{ table: string; column: string }> } = {
  encrypt: [],
  decrypt: [],
};

vi.mock('../secretCrypto', () => ({
  encryptSecret: (s: string | null | undefined, opts: { aad?: string } = {}) => {
    cryptoCalls.encrypt.push({ aad: opts.aad });
    return s == null ? null : `enc:v3:${Buffer.from(s, 'utf8').toString('base64')}`;
  },
  decryptForColumn: (table: string, column: string, s: string | null | undefined) => {
    cryptoCalls.decrypt.push({ table, column });
    return s == null ? null : Buffer.from(s.replace(/^enc:v3:/, ''), 'base64').toString('utf8');
  },
}));

// The service reaches Postgres only through its TrustKeyStore seam (replaced
// below); hotPathCache still imports these from the db module.
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  hasDbAccessContext: () => false,
  runAfterDbContextExit: (_label: string, work: () => unknown) => { work(); },
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { work(); },
}));

/** Fake Redis for the revoke purge: SCAN MATCH prefix* + DEL. */
const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    enabled: true,
    client: {
      scan: async (_cursor: string, _match: string, pattern: string) => {
        const prefix = pattern.replace(/\*$/, '');
        return ['0', [...store.keys()].filter((k) => k.startsWith(prefix))];
      },
      del: async (...keys: string[]) => keys.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0),
    },
  };
});
vi.mock('../redis', () => ({ getRedis: () => (redis.enabled ? redis.client : null) }));

import {
  ensureActiveTrustSigningKey,
  loadTrustJwks,
  loadTrustSigningKey,
  listTrustSigningKeys,
  prepareTrustSigningKey,
  activateTrustSigningKey,
  revokeTrustSigningKey,
  TrustAttestationUnavailable,
  TrustSigningKeyError,
  TRUST_KEYSET_CACHE_TTL_MS,
  TRUST_JWKS_MAX_AGE_SECONDS,
  trustAttestationCachePrefix,
  __setTrustKeyStoreForTests,
  type TrustKeyRow,
  type TrustKeyStore,
  type TrustKeyTx,
} from './attestationKeys';
import { __resetHotPathCachesForTests } from '../hotPathCache';

const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

/** Transactional in-memory store: a run() works on a copy and commits it only when fn resolves. */
class MemoryStore implements TrustKeyStore {
  rows: TrustKeyRow[] = [];
  runs = 0;
  lists = 0;
  /** Called before an insert lands; lets a test inject a concurrent winner. */
  beforeInsert: ((rows: TrustKeyRow[]) => void) | null = null;

  async run<T>(fn: (tx: TrustKeyTx) => Promise<T>): Promise<T> {
    this.runs += 1;
    const working = this.rows.map((r) => ({ ...r }));
    const tx: TrustKeyTx = {
      list: async () => { this.lists += 1; return working.map((r) => ({ ...r })); },
      insert: async (row) => {
        this.beforeInsert?.(working);
        this.beforeInsert = null;
        if (row.status === 'active' && working.some((r) => r.status === 'active')) return false; // partial unique index
        if (working.some((r) => r.kid === row.kid)) throw new Error('duplicate kid');
        working.push({
          kid: row.kid, publicJwk: row.publicJwk, privateKeyEnc: row.privateKeyEnc, status: row.status,
          createdAt: new Date(), activatedAt: row.activatedAt ?? null, retiredAt: null, revokedAt: null,
        });
        return true;
      },
      update: async (kid, patch) => {
        const row = working.find((r) => r.kid === kid);
        if (!row) throw new Error(`no row ${kid}`);
        Object.assign(row, patch);
        if (row.status === 'active' && working.filter((r) => r.status === 'active').length > 1) {
          throw new Error('duplicate key value violates unique constraint "trust_signing_keys_one_active_uq"');
        }
        if (!(row.status === 'verify_only' || row.status === 'revoked') && row.privateKeyEnc == null) {
          throw new Error('check constraint violated: private key required');
        }
      },
    };
    const result = await fn(tx);
    this.rows = working;
    return result;
  }
}

async function makeRow(status: TrustKeyRow['status'], kid: string, createdAt = new Date()): Promise<TrustKeyRow> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pub = await exportJWK(publicKey);
  const priv = await exportJWK(privateKey);
  const keepsPrivate = status === 'pending' || status === 'active';
  return {
    kid, publicJwk: pub, privateKeyEnc: keepsPrivate ? `enc:v3:${Buffer.from(JSON.stringify(priv)).toString('base64')}` : null,
    status, createdAt, activatedAt: status === 'active' ? createdAt : null, retiredAt: null, revokedAt: null,
  };
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  __setTrustKeyStoreForTests(store);
  __resetHotPathCachesForTests();
  cryptoCalls.encrypt = [];
  cryptoCalls.decrypt = [];
  redis.store.clear();
  redis.enabled = true;
});
afterEach(() => {
  __setTrustKeyStoreForTests(null);
  vi.useRealTimers();
});

describe('ensureActiveTrustSigningKey', () => {
  it('generates an ES256 P-256 key when the table is empty, stores the public JWK without d, encrypts the private JWK with AAD trust_signing_keys.private_key_enc', async () => {
    const active = await ensureActiveTrustSigningKey();

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.status).toBe('active');
    expect(row.activatedAt).toBeInstanceOf(Date);
    expect(row.kid).toBe(active.kid);
    expect(row.kid).toMatch(/^trust-[A-Za-z0-9_-]{16}$/);
    expect(row.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    for (const f of PRIVATE_FIELDS) expect(row.publicJwk).not.toHaveProperty(f);
    expect(active.publicJwk).toEqual(row.publicJwk);

    expect(cryptoCalls.encrypt).toEqual([{ aad: 'trust_signing_keys.private_key_enc' }]);
    const decrypted = JSON.parse(Buffer.from(row.privateKeyEnc!.replace(/^enc:v3:/, ''), 'base64').toString('utf8')) as JWK;
    expect(decrypted.d).toEqual(expect.any(String));
    expect(decrypted).toMatchObject({ kty: 'EC', crv: 'P-256', x: row.publicJwk.x, y: row.publicJwk.y });
  });

  it('returns the existing active key without generating', async () => {
    store.rows = [await makeRow('active', 'trust-existingkey00001')];
    const active = await ensureActiveTrustSigningKey();
    expect(active.kid).toBe('trust-existingkey00001');
    expect(store.rows).toHaveLength(1);
    expect(cryptoCalls.encrypt).toHaveLength(0);
  });

  it('rows exist but none is active → throws TrustAttestationUnavailable and does NOT generate', async () => {
    store.rows = [await makeRow('revoked', 'trust-revokedkey000001'), await makeRow('verify_only', 'trust-verifyonly000001')];
    await expect(ensureActiveTrustSigningKey()).rejects.toBeInstanceOf(TrustAttestationUnavailable);
    expect(store.rows).toHaveLength(2);
    expect(store.rows.some((r) => r.status === 'active')).toBe(false);
    expect(cryptoCalls.encrypt).toHaveLength(0);
  });

  it('a pending key alone does not count as "never had a key": no bootstrap', async () => {
    store.rows = [await makeRow('pending', 'trust-pendingkey000001')];
    await expect(ensureActiveTrustSigningKey()).rejects.toBeInstanceOf(TrustAttestationUnavailable);
    expect(store.rows).toHaveLength(1);
  });

  it('a concurrent first insert (conflict on the one-active partial unique index) re-reads the winner instead of failing', async () => {
    const winner = await makeRow('active', 'trust-concurrentwinner');
    store.beforeInsert = (rows) => { rows.push(winner); };
    const active = await ensureActiveTrustSigningKey();
    expect(active.kid).toBe('trust-concurrentwinner');
    expect(store.rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });
});

describe('loadTrustJwks', () => {
  it('returns pending + active + verify_only keys, never revoked, never private fields (no d/p/q/dp/dq/qi)', async () => {
    store.rows = [
      await makeRow('pending', 'trust-pending000000001'),
      await makeRow('active', 'trust-active0000000001'),
      await makeRow('verify_only', 'trust-verifyonly000001'),
      await makeRow('revoked', 'trust-revoked000000001'),
    ];
    // Plant private material on the public column too: the JWKS must strip it regardless.
    store.rows[1]!.publicJwk = { ...store.rows[1]!.publicJwk, d: 'leak', p: 'leak', q: 'leak', dp: 'leak', dq: 'leak', qi: 'leak' };

    const jwks = await loadTrustJwks();
    expect(jwks.keys.map((k) => k.kid).sort()).toEqual(['trust-active0000000001', 'trust-pending000000001', 'trust-verifyonly000001']);
    for (const k of jwks.keys) {
      for (const f of PRIVATE_FIELDS) expect(k).not.toHaveProperty(f);
      expect(k).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    }
    expect(JSON.stringify(jwks)).not.toContain('leak');
  });
});

describe('activateTrustSigningKey', () => {
  it('moves the current active to verify_only and nulls its private_key_enc in one transaction', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    store.rows = [
      await makeRow('active', 'trust-old0000000000001', new Date('2026-01-01T00:00:00Z')),
      await makeRow('pending', 'trust-new0000000000001', new Date('2026-10-16T09:00:00Z')),
    ];
    const runsBefore = store.runs;

    await activateTrustSigningKey('trust-new0000000000001');

    expect(store.runs - runsBefore).toBe(1);
    const old = store.rows.find((r) => r.kid === 'trust-old0000000000001')!;
    const next = store.rows.find((r) => r.kid === 'trust-new0000000000001')!;
    expect(old).toMatchObject({ status: 'verify_only', privateKeyEnc: null });
    expect(old.retiredAt?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
    expect(next.status).toBe('active');
    expect(next.privateKeyEnc).not.toBeNull();
    expect(next.activatedAt?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
  });

  it('refuses a kid that is not pending', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001'), await makeRow('verify_only', 'trust-verifyonly000001')];
    await expect(activateTrustSigningKey('trust-verifyonly000001')).rejects.toBeInstanceOf(TrustSigningKeyError);
    await expect(activateTrustSigningKey('trust-active0000000001')).rejects.toBeInstanceOf(TrustSigningKeyError);
    await expect(activateTrustSigningKey('trust-unknown000000001')).rejects.toBeInstanceOf(TrustSigningKeyError);
    expect(store.rows.find((r) => r.kid === 'trust-active0000000001')!.status).toBe('active');
  });

  it(`refuses when the pending key is younger than the JWKS max-age (${600} s) unless --force`, async () => {
    expect(TRUST_JWKS_MAX_AGE_SECONDS).toBe(600);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    store.rows = [
      await makeRow('active', 'trust-old0000000000001', new Date('2026-01-01T00:00:00Z')),
      await makeRow('pending', 'trust-new0000000000001', new Date('2026-10-16T09:55:00Z')), // 300 s old
    ];
    await expect(activateTrustSigningKey('trust-new0000000000001')).rejects.toThrow(/600/);
    expect(store.rows.find((r) => r.kid === 'trust-new0000000000001')!.status).toBe('pending');

    await activateTrustSigningKey('trust-new0000000000001', { force: true });
    expect(store.rows.find((r) => r.kid === 'trust-new0000000000001')!.status).toBe('active');
  });
});

describe('revokeTrustSigningKey', () => {
  it('marks it revoked and nulls the private key; without --replace no active key remains', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    await revokeTrustSigningKey('trust-active0000000001');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: 'revoked', privateKeyEnc: null });
    expect(store.rows[0]!.revokedAt).toBeInstanceOf(Date);
    // A revoke never silently mints a replacement (quorum B1).
    await expect(ensureActiveTrustSigningKey()).rejects.toBeInstanceOf(TrustAttestationUnavailable);
    expect(store.rows).toHaveLength(1);
  });

  it('with --replace it also creates and activates a successor in the same transaction', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    const runsBefore = store.runs;
    await revokeTrustSigningKey('trust-active0000000001', { replace: true });
    expect(store.runs - runsBefore).toBe(1);
    const active = store.rows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.kid).not.toBe('trust-active0000000001');
    expect(active[0]!.privateKeyEnc).not.toBeNull();
    expect(store.rows.find((r) => r.kid === 'trust-active0000000001')!.status).toBe('revoked');
  });

  it('revokes a verify_only key (it leaves the JWKS); refuses an already-revoked or unknown kid', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001'), await makeRow('verify_only', 'trust-verifyonly000001')];
    await revokeTrustSigningKey('trust-verifyonly000001');
    expect((await loadTrustJwks()).keys.map((k) => k.kid)).toEqual(['trust-active0000000001']);
    await expect(revokeTrustSigningKey('trust-verifyonly000001')).rejects.toBeInstanceOf(TrustSigningKeyError);
    await expect(revokeTrustSigningKey('trust-unknown000000001')).rejects.toBeInstanceOf(TrustSigningKeyError);
  });

  it("purges the revoked key's cached tokens and leaves other keys' tokens alone", async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001'), await makeRow('verify_only', 'trust-verifyonly000001')];
    redis.store.set(`${trustAttestationCachePrefix('trust-active0000000001')}aaa:snap:1`, 'tokA1');
    redis.store.set(`${trustAttestationCachePrefix('trust-active0000000001')}bbb:snap:2`, 'tokA2');
    redis.store.set(`${trustAttestationCachePrefix('trust-verifyonly000001')}aaa:snap:1`, 'tokV');
    await revokeTrustSigningKey('trust-active0000000001', { replace: true });
    expect([...redis.store.values()]).toEqual(['tokV']);
  });

  it('a revoke still commits when Redis is unavailable for the purge', async () => {
    redis.enabled = false;
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    await revokeTrustSigningKey('trust-active0000000001', { replace: true });
    expect(store.rows.find((r) => r.kid === 'trust-active0000000001')!.status).toBe('revoked');
  });

  it('refuses --replace for a key that is not the active one', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001'), await makeRow('verify_only', 'trust-verifyonly000001')];
    await expect(revokeTrustSigningKey('trust-verifyonly000001', { replace: true })).rejects.toBeInstanceOf(TrustSigningKeyError);
    expect(store.rows.find((r) => r.kid === 'trust-verifyonly000001')!.status).toBe('verify_only');
  });
});

describe('prepareTrustSigningKey', () => {
  it('creates a pending key that appears in the JWKS but does not sign', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    const prepared = await prepareTrustSigningKey();
    expect(store.rows.find((r) => r.kid === prepared.kid)).toMatchObject({ status: 'pending' });
    expect((await ensureActiveTrustSigningKey()).kid).toBe('trust-active0000000001');
    expect((await loadTrustJwks()).keys.map((k) => k.kid)).toContain(prepared.kid);
  });

  it('a concurrent prepare that loses on the one-pending index gets a TrustSigningKeyError, not a raw SQL error', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    const raced: TrustKeyStore = {
      run: async () => { throw Object.assign(new Error('insert failed'), { cause: { code: '23505' } }); },
    };
    __setTrustKeyStoreForTests(raced);
    await expect(prepareTrustSigningKey()).rejects.toBeInstanceOf(TrustSigningKeyError);
    await expect(activateTrustSigningKey('trust-x')).rejects.toBeInstanceOf(TrustSigningKeyError);
  });

  it('refuses while another key is already pending', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001'), await makeRow('pending', 'trust-pending000000001')];
    await expect(prepareTrustSigningKey()).rejects.toBeInstanceOf(TrustSigningKeyError);
  });
});

describe('listTrustSigningKeys', () => {
  it('reports kid, status and dates, never private material', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    const listed = await listTrustSigningKeys();
    expect(listed).toEqual([expect.objectContaining({ kid: 'trust-active0000000001', status: 'active' })]);
    expect(JSON.stringify(listed)).not.toContain('enc:v3');
    expect(listed[0]).not.toHaveProperty('privateKeyEnc');
  });
});

describe('loadTrustSigningKey', () => {
  it('decrypts the active key through decryptForColumn(trust_signing_keys, private_key_enc)', async () => {
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    const key = await loadTrustSigningKey('trust-active0000000001');
    expect(key).toBeDefined();
    expect(cryptoCalls.decrypt).toEqual([{ table: 'trust_signing_keys', column: 'private_key_enc' }]);
  });

  it('refuses a kid that is no longer active (rotated or revoked since it was cached)', async () => {
    store.rows = [await makeRow('verify_only', 'trust-verifyonly000001'), await makeRow('active', 'trust-active0000000001')];
    await expect(loadTrustSigningKey('trust-verifyonly000001')).rejects.toBeInstanceOf(TrustAttestationUnavailable);
  });
});

describe('keyset cache', () => {
  it(`is cached per instance for ${TRUST_KEYSET_CACHE_TTL_MS / 1000} s`, async () => {
    expect(TRUST_KEYSET_CACHE_TTL_MS).toBe(60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    store.rows = [await makeRow('active', 'trust-active0000000001')];
    await loadTrustJwks();
    await loadTrustJwks();
    await ensureActiveTrustSigningKey();
    expect(store.lists).toBe(1);
    vi.setSystemTime(Date.now() + TRUST_KEYSET_CACHE_TTL_MS + 1);
    await loadTrustJwks();
    expect(store.lists).toBe(2);
  });

  it('is invalidated locally on prepare/activate/revoke', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    store.rows = [await makeRow('active', 'trust-active0000000001', new Date('2026-01-01T00:00:00Z'))];
    expect((await loadTrustJwks()).keys).toHaveLength(1);

    const prepared = await prepareTrustSigningKey();
    expect((await loadTrustJwks()).keys.map((k) => k.kid)).toContain(prepared.kid);

    vi.setSystemTime(new Date('2026-10-16T10:11:00Z'));
    await activateTrustSigningKey(prepared.kid);
    expect((await ensureActiveTrustSigningKey()).kid).toBe(prepared.kid);

    await revokeTrustSigningKey('trust-active0000000001');
    expect((await loadTrustJwks()).keys.map((k) => k.kid)).toEqual([prepared.kid]);
  });
});
