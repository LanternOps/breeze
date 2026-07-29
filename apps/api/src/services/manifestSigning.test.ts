import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./secretCrypto', () => ({
  encryptSecret: (s: string | null | undefined) =>
    s == null ? null : `enc:v1:${Buffer.from(s, 'utf8').toString('base64')}`,
  decryptSecret: (s: string | null | undefined) =>
    s == null
      ? null
      : Buffer.from(s.replace(/^enc:v1:/, ''), 'base64').toString('utf8'),
  decryptForColumn: (_t: string, _c: string, s: string | null | undefined) =>
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

interface FakeDelegationRow {
  epoch: number;
  oldKeyId: string;
  newKeyId: string;
  newPublicKeyB64: string;
  notBefore: Date;
  notAfter: Date;
  signatureB64: string;
  activatedAt: Date | null;
}

const dbState: { rows: FakeRow[]; delegations: FakeDelegationRow[] } = {
  rows: [],
  delegations: [],
};

vi.mock('../db', () => {
  const filterActive = () => dbState.rows.filter((r) => r.status === 'active');
  // Drizzle stamps the SQL table name on this well-known symbol; the fake
  // `from()` routes on it so one db mock can serve both tables.
  const tableName = (t: unknown): string =>
    (t as Record<symbol, string>)?.[Symbol.for('drizzle:Name')] ?? '';
  return {
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const isDelegations =
              tableName(table) === 'manifest_signing_key_delegations';
            // The service applies its own window predicate through SQL, which
            // this fake cannot evaluate. Tests that care about window
            // filtering seed `dbState.delegations` with exactly the rows the
            // real predicate would have returned, and assert on the SHAPE the
            // service maps them into (that mapping is the part under test
            // here); the predicate itself is asserted against real Postgres in
            // rls-coverage.integration.test.ts.
            const rowsFn = () =>
              isDelegations ? dbState.delegations : filterActive();
            return {
              limit: async () => rowsFn().slice(0, 1),
              orderBy: () => ({
                then: (resolve: (rows: unknown[]) => unknown) =>
                  Promise.resolve(rowsFn()).then(resolve),
              }),
              then: (resolve: (rows: unknown[]) => unknown) =>
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
  manifestDelegationCanonicalBytes,
  MANIFEST_DELEGATION_DOMAIN,
  getActiveManifestKeyDelegations,
  signManifestKeyDelegation,
  verifyManifestKeyDelegation,
} from './manifestSigning';

describe('manifestSigning', () => {
  beforeEach(() => {
    dbState.rows = [];
    dbState.delegations = [];
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

// =====================================================================
// Canonical delegation signing payload (Wave 6 Task 7)
//
// This byte layout is a WIRE CONTRACT between the API and the Go agent.
// A single differing byte — including a trailing newline — makes every
// delegation unverifiable fleet-wide while looking completely fine on
// each side in isolation. So the layout is asserted here as literal
// bytes AND pinned by a SHA-256 digest over a fixed fixture; the Go
// side (agent/internal/config/manifestkeys_test.go) pins the SAME
// digest over the SAME fixture. If either side's layout drifts, the two
// digests stop matching and one of the two tests goes red.
// =====================================================================
describe('manifestDelegationCanonicalBytes', () => {
  // Shared golden fixture. Keep byte-identical with the Go test's
  // goldenDelegationFixture.
  const FIXTURE = {
    oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
    newKeyId: 'deploy-2026-08-06-bbbbbbbb',
    // Raw bytes 0x01..0x20 — a structurally valid 32-byte key.
    newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    epoch: 7,
    notBefore: '2026-08-06T00:00:00Z',
    notAfter: '2026-09-05T00:00:00Z',
  };

  // sha256 of the canonical bytes for FIXTURE. MUST equal the constant of
  // the same name in the Go test.
  const GOLDEN_SHA256 =
    '4920f7f3e4afc227dc3e199204a46649e0d2ff1fc07f2b653cd9cd15d2d7e84e';

  it('is exactly the seven specified lines, LF-joined, with NO trailing newline', () => {
    const bytes = manifestDelegationCanonicalBytes(FIXTURE);
    const text = bytes.toString('utf8');

    expect(text.split('\n')).toEqual([
      'breeze-manifest-key-delegation-v1',
      'deploy-2026-05-09-aaaaaaaa',
      'deploy-2026-08-06-bbbbbbbb',
      'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
      '7',
      '2026-08-06T00:00:00Z',
      '2026-09-05T00:00:00Z',
    ]);
    // Explicit, because "join produced 7 elements" is also true of a
    // string with a trailing newline plus an empty 8th element.
    expect(text.endsWith('\n')).toBe(false);
    expect(text.startsWith(MANIFEST_DELEGATION_DOMAIN + '\n')).toBe(true);
    expect(bytes).toHaveLength(176);
  });

  it('matches the cross-language golden digest (byte-for-byte agreement with the Go agent)', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256')
      .update(manifestDelegationCanonicalBytes(FIXTURE))
      .digest('hex');
    expect(digest).toBe(GOLDEN_SHA256);
  });

  it('renders the epoch as an unsigned decimal, not as JSON or exponent notation', () => {
    const text = manifestDelegationCanonicalBytes({
      ...FIXTURE,
      epoch: 1_000_000,
    }).toString('utf8');
    expect(text.split('\n')[4]).toBe('1000000');
  });

  it('changes when ANY field changes (every field is bound by the signature)', () => {
    const base = manifestDelegationCanonicalBytes(FIXTURE).toString('utf8');
    const mutations: Array<Partial<typeof FIXTURE>> = [
      { oldKeyId: 'deploy-other' },
      { newKeyId: 'deploy-other' },
      { newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyE=' },
      { epoch: 8 },
      { notBefore: '2026-08-06T00:00:01Z' },
      { notAfter: '2026-09-05T00:00:01Z' },
    ];
    for (const mutation of mutations) {
      expect(
        manifestDelegationCanonicalBytes({ ...FIXTURE, ...mutation }).toString(
          'utf8',
        ),
        `mutation ${JSON.stringify(mutation)} did not change the signed bytes`,
      ).not.toBe(base);
    }
  });

  it('renders the window exactly as supplied, so the agent can rebuild the bytes from the wire fields verbatim', () => {
    // The agent does NOT reformat notBefore/notAfter before verifying — it
    // signs over the literal strings it received. Any reformatting on either
    // side (millisecond precision, +00:00 vs Z) would break verification, so
    // the canonical builder must be a pure pass-through for these two.
    const text = manifestDelegationCanonicalBytes({
      ...FIXTURE,
      notBefore: '2026-08-06T00:00:00Z',
      notAfter: '2026-09-05T12:34:56Z',
    }).toString('utf8');
    const lines = text.split('\n');
    expect(lines[5]).toBe('2026-08-06T00:00:00Z');
    expect(lines[6]).toBe('2026-09-05T12:34:56Z');
  });

  it('rejects a key id containing the line separator (canonical-form injection)', () => {
    // Without this guard an attacker-chosen key id containing a newline
    // could shift the meaning of later lines while keeping the same bytes.
    expect(() =>
      manifestDelegationCanonicalBytes({
        ...FIXTURE,
        newKeyId: 'evil\n2026-01-01T00:00:00Z',
      }),
    ).toThrow(/newline|malformed/i);
  });
});

// =====================================================================
// Delivery: getActiveManifestKeyDelegations
//
// Enrollment and heartbeat hand these records to agents. The service's job
// is to project stored rows onto the exact wire shape the agent decodes,
// with the epoch as a JSON number and the window as canonical RFC3339 'Z'
// strings — the same strings that were signed.
// =====================================================================
describe('getActiveManifestKeyDelegations', () => {
  beforeEach(() => {
    dbState.rows = [];
    dbState.delegations = [];
  });

  function seed(overrides: Partial<(typeof dbState.delegations)[number]> = {}) {
    dbState.delegations.push({
      epoch: 7,
      oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
      newKeyId: 'deploy-2026-08-06-bbbbbbbb',
      newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
      notBefore: new Date('2026-08-06T00:00:00Z'),
      notAfter: new Date('2026-09-05T00:00:00Z'),
      signatureB64: 'c2ln',
      activatedAt: null,
      ...overrides,
    });
  }

  it('returns [] when nothing is prepared', async () => {
    expect(await getActiveManifestKeyDelegations()).toEqual([]);
  });

  it('projects a stored row onto the exact ManifestKeyDelegation wire shape', async () => {
    seed();
    const [record] = await getActiveManifestKeyDelegations();

    expect(record).toEqual({
      schemaVersion: 1,
      oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
      newKeyId: 'deploy-2026-08-06-bbbbbbbb',
      newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
      epoch: 7,
      notBefore: '2026-08-06T00:00:00Z',
      notAfter: '2026-09-05T00:00:00Z',
      signatureBase64: 'c2ln',
    });
    // No extra keys: anything unexpected on the wire is either a leak or a
    // field the agent will ignore while believing it was signed.
    expect(Object.keys(record!).sort()).toEqual(
      [
        'epoch',
        'newKeyId',
        'newPublicKeyB64',
        'notAfter',
        'notBefore',
        'oldKeyId',
        'schemaVersion',
        'signatureBase64',
      ].sort(),
    );
  });

  it('serialises the window as second-precision RFC3339 Z — the exact strings that were signed', async () => {
    // toISOString() would render '.000Z'. That is still valid RFC3339 but it
    // is NOT what the signer produced, so the agent's reconstruction would
    // differ by four bytes and every signature would fail to verify.
    seed({
      notBefore: new Date('2026-08-06T00:00:00.000Z'),
      notAfter: new Date('2026-09-05T12:34:56.000Z'),
    });
    const [record] = await getActiveManifestKeyDelegations();
    expect(record!.notBefore).toBe('2026-08-06T00:00:00Z');
    expect(record!.notAfter).toBe('2026-09-05T12:34:56Z');
    expect(record!.notBefore).not.toMatch(/\./);
  });

  it('still delivers a record that has already been activated (stragglers must be able to adopt)', async () => {
    seed({ activatedAt: new Date('2026-08-10T00:00:00Z') });
    const records = await getActiveManifestKeyDelegations();
    expect(records).toHaveLength(1);
    expect(records[0]!.epoch).toBe(7);
  });

  it('emits the epoch as a JSON number, never a string or bigint', async () => {
    seed({ epoch: 42 });
    const [record] = await getActiveManifestKeyDelegations();
    expect(typeof record!.epoch).toBe('number');
    expect(JSON.parse(JSON.stringify(record)).epoch).toBe(42);
  });
});

describe('signManifestKeyDelegation / verifyManifestKeyDelegation', () => {
  beforeEach(() => {
    dbState.rows = [];
    dbState.delegations = [];
  });

  const FIELDS = {
    oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
    newKeyId: 'deploy-2026-08-06-bbbbbbbb',
    newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    epoch: 7,
    notBefore: '2026-08-06T00:00:00Z',
    notAfter: '2026-09-05T00:00:00Z',
  };

  async function freshKeypair() {
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    return {
      publicKeyB64: spki.subarray(spki.length - 32).toString('base64'),
      seedB64: pkcs8.subarray(pkcs8.length - 32).toString('base64'),
    };
  }

  it('round-trips: a delegation signed by a key verifies against that key', async () => {
    const { publicKeyB64, seedB64 } = await freshKeypair();
    const sig = signManifestKeyDelegation(FIELDS, seedB64);
    expect(verifyManifestKeyDelegation(FIELDS, sig, publicKeyB64)).toBe(true);
  });

  it('does NOT verify against a different key (only the currently trusted key can delegate)', async () => {
    const signer = await freshKeypair();
    const impostor = await freshKeypair();
    const sig = signManifestKeyDelegation(FIELDS, signer.seedB64);
    expect(verifyManifestKeyDelegation(FIELDS, sig, impostor.publicKeyB64)).toBe(
      false,
    );
  });

  it('does NOT verify when any signed field is altered after signing', async () => {
    const { publicKeyB64, seedB64 } = await freshKeypair();
    const sig = signManifestKeyDelegation(FIELDS, seedB64);

    const tampered: Array<Partial<typeof FIELDS>> = [
      { epoch: 8 },
      { newKeyId: 'deploy-attacker' },
      { newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyE=' },
      { notAfter: '2030-01-01T00:00:00Z' },
      { oldKeyId: 'deploy-other' },
      { notBefore: '2020-01-01T00:00:00Z' },
    ];
    for (const patch of tampered) {
      expect(
        verifyManifestKeyDelegation({ ...FIELDS, ...patch }, sig, publicKeyB64),
        `tampering with ${JSON.stringify(patch)} still verified`,
      ).toBe(false);
    }
  });

  it('rejects a malformed public key rather than throwing', async () => {
    const { seedB64 } = await freshKeypair();
    const sig = signManifestKeyDelegation(FIELDS, seedB64);
    expect(verifyManifestKeyDelegation(FIELDS, sig, 'dG9vLXNob3J0')).toBe(false);
    expect(verifyManifestKeyDelegation(FIELDS, 'not-base64!!', 'dG9v')).toBe(
      false,
    );
  });

  it('returns false (never throws) for a right-length key that is not a valid Ed25519 point', async () => {
    // The length guard passes — this IS 32 bytes — but SPKI import can still
    // reject it. The function is documented to return a boolean, so this must
    // not escape as an exception to the rotation CLI's self-check.
    const { seedB64 } = await freshKeypair();
    const sig = signManifestKeyDelegation(FIELDS, seedB64);

    const candidates = [
      Buffer.alloc(32, 0x00).toString('base64'),
      Buffer.alloc(32, 0xff).toString('base64'),
      Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)).toString('base64'),
    ];
    for (const publicKeyB64 of candidates) {
      expect(
        () => verifyManifestKeyDelegation(FIELDS, sig, publicKeyB64),
        `verify threw for ${publicKeyB64}`,
      ).not.toThrow();
      expect(verifyManifestKeyDelegation(FIELDS, sig, publicKeyB64)).toBe(false);
    }
  });
});
