import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./secretCrypto', () => ({
  encryptSecret: (s: string | null | undefined) =>
    s == null ? null : `enc:v1:${Buffer.from(s, 'utf8').toString('base64')}`,
  decryptSecret: (s: string | null | undefined) =>
    s == null
      ? null
      : Buffer.from(s.replace(/^enc:v1:/, ''), 'base64').toString('utf8'),
}));

interface FakeRow {
  keyId: string;
  publicKeyB64: string;
  privateKeyEnc: string;
  status: string;
  createdAt: Date;
}

const dbState: { rows: FakeRow[] } = { rows: [] };

vi.mock('../db', () => {
  const filterActive = () => dbState.rows.filter((r) => r.status === 'active');
  return {
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            const rowsFn = () => filterActive();
            return {
              limit: async () => rowsFn().slice(0, 1),
              then: (resolve: (rows: FakeRow[]) => unknown) =>
                Promise.resolve(rowsFn()).then(resolve),
            };
          },
        }),
      }),
      insert: () => ({
        values: (v: Omit<FakeRow, 'createdAt'>) => {
          // Mimic the partial unique index on (status) WHERE status='active':
          // if an active row already exists, onConflictDoNothing returns []
          // and the row is not inserted. Otherwise the insert lands.
          const hadActive = filterActive().length > 0;
          if (!hadActive) {
            dbState.rows.push({ ...v, createdAt: new Date() });
          }
          const inserted = hadActive ? [] : [{ keyId: v.keyId }];
          const builder = {
            onConflictDoNothing: () => ({
              returning: async () => inserted,
            }),
            // Legacy callers that don't chain onConflictDoNothing still get
            // the un-conflicted insert path; if the row already existed,
            // simulate the throw that the real partial unique index would
            // emit. (Keeps coverage honest for any future regression.)
            then: (resolve: (v: void) => unknown) => {
              if (hadActive) {
                return Promise.reject(
                  new Error(
                    'duplicate key value violates unique constraint "uq_manifest_signing_keys_active"',
                  ),
                ).then(resolve as never);
              }
              return Promise.resolve().then(resolve);
            },
          };
          return builder;
        },
      }),
    },
  };
});

import {
  ensureActiveSigningKey,
  signManifest,
  getActivePublicKeys,
  getActiveTrustKeyset,
} from './manifestSigning';

describe('manifestSigning', () => {
  beforeEach(() => {
    dbState.rows = [];
  });

  it('generates a fresh Ed25519 key when none active', async () => {
    const key = await ensureActiveSigningKey();
    expect(key.keyId).toMatch(/^deploy-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(Buffer.from(key.publicKeyB64, 'base64')).toHaveLength(32);
    expect(dbState.rows).toHaveLength(1);
    expect(dbState.rows[0]!.status).toBe('active');
  });

  it('reuses the active key on subsequent calls', async () => {
    const a = await ensureActiveSigningKey();
    const b = await ensureActiveSigningKey();
    expect(b.keyId).toBe(a.keyId);
    expect(dbState.rows).toHaveLength(1);
  });

  it('signs a manifest with a signature that the public key verifies', async () => {
    await ensureActiveSigningKey();
    const manifest = JSON.stringify({
      version: '0.65.9',
      component: 'agent',
      platform: 'windows',
      arch: 'amd64',
      url: 'https://x',
      checksum: 'a'.repeat(64),
      size: 100,
    });

    const sigB64 = await signManifest(manifest);
    const [pubB64] = await getActivePublicKeys();
    expect(pubB64).toBeDefined();

    const { createPublicKey, verify } = await import('node:crypto');
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(pubB64!, 'base64'),
    ]);
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const ok = verify(
      null,
      Buffer.from(manifest, 'utf8'),
      publicKey,
      Buffer.from(sigB64, 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('signManifest throws when no active key exists', async () => {
    await expect(signManifest('{}')).rejects.toThrow(
      /no active manifest signing key/,
    );
  });

  it('returns the existing active key when an insert conflict fires (race) (#640)', async () => {
    // Simulate: loadActive() returns null first (so we enter the generate
    // branch), then a concurrent caller inserts an active row before our
    // own INSERT lands, so onConflictDoNothing returns []. We must reload
    // and return the winner's row rather than throw.
    const winnerRow: FakeRow = {
      keyId: 'deploy-2026-05-14-aaaaaaaa',
      publicKeyB64: 'd2lubmVy', // 'winner' base64-ish
      privateKeyEnc: 'enc:v1:d2lubmVy',
      status: 'active',
      createdAt: new Date('2026-05-14T00:00:00Z'),
    };

    // Track loadActive calls — first must be null (so we generate), second
    // (after the conflict) must be the winner row.
    const { db } = await import('../db');
    let loadCount = 0;
    const realSelect = db.select;
    (db as unknown as { select: (...args: unknown[]) => unknown }).select = () => ({
      from: () => ({
        where: () => {
          loadCount += 1;
          const rows = loadCount === 1 ? [] : [winnerRow];
          return {
            limit: async () => rows,
            then: (resolve: (rows: FakeRow[]) => unknown) =>
              Promise.resolve(rows).then(resolve),
          };
        },
      }),
    });

    // Force insert path to report a conflict regardless of dbState.
    const realInsert = db.insert;
    (db as unknown as { insert: (...args: unknown[]) => unknown }).insert = () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [],
        }),
      }),
    });

    try {
      const result = await ensureActiveSigningKey();
      expect(result.keyId).toBe(winnerRow.keyId);
      expect(result.publicKeyB64).toBe(winnerRow.publicKeyB64);
    } finally {
      (db as unknown as { select: typeof realSelect }).select = realSelect;
      (db as unknown as { insert: typeof realInsert }).insert = realInsert;
    }
  });

  it('getActiveTrustKeyset returns keyId + publicKeyB64 + ISO validFrom', async () => {
    await ensureActiveSigningKey();
    const keyset = await getActiveTrustKeyset();
    expect(keyset).toHaveLength(1);
    expect(keyset[0]!.keyId).toMatch(/^deploy-/);
    expect(keyset[0]!.publicKeyB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(() => new Date(keyset[0]!.validFrom).toISOString()).not.toThrow();
  });
});
