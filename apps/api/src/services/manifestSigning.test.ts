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
        values: async (v: Omit<FakeRow, 'createdAt'>) => {
          dbState.rows.push({ ...v, createdAt: new Date() });
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

  it('getActiveTrustKeyset returns keyId + publicKeyB64 + ISO validFrom', async () => {
    await ensureActiveSigningKey();
    const keyset = await getActiveTrustKeyset();
    expect(keyset).toHaveLength(1);
    expect(keyset[0]!.keyId).toMatch(/^deploy-/);
    expect(keyset[0]!.publicKeyB64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(() => new Date(keyset[0]!.validFrom).toISOString()).not.toThrow();
  });
});
