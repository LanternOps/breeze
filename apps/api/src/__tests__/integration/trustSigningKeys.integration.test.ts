import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { trustSigningKeys } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import {
  activateTrustSigningKey,
  ensureActiveTrustSigningKey,
  loadTrustJwks,
  loadTrustSigningKey,
  prepareTrustSigningKey,
  revokeTrustSigningKey,
  TrustAttestationUnavailable,
  TrustSigningKeyError,
} from '../../services/trustPage/attestationKeys';
import { __resetHotPathCachesForTests } from '../../services/hotPathCache';

// Trust Center W3b (#8771): trust_signing_keys is per-deployment infrastructure
// with forced RLS and a single system-only policy. cleanupDatabase() does not
// truncate it, so each test starts from an empty table itself.
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function emptyKeyset(): Promise<void> {
  await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM trust_signing_keys`));
  __resetHotPathCachesForTests();
}

async function orgContext(): Promise<DbAccessContext> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `trust-keys-${Date.now()}@example.com` });
    return { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: user.id };
  });
}

describe('trust_signing_keys forced system-only RLS', () => {
  beforeEach(emptyKeyset);

  runDb('an org-scoped breeze_app context reads 0 rows and cannot insert (42501)', async () => {
    const active = await ensureActiveTrustSigningKey();
    const ctx = await orgContext();

    const who = await withDbAccessContext(ctx, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((who as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0]).toEqual({ who: 'breeze_app', rolbypassrls: false });

    const selected = await withDbAccessContext(ctx, () => db.select({ kid: trustSigningKeys.kid }).from(trustSigningKeys));
    expect(selected).toEqual([]);

    await expect(withDbAccessContext(ctx, () => db.insert(trustSigningKeys).values({
      kid: 'trust-orgscopedinsert0',
      publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      privateKeyEnc: 'not-a-real-key',
      status: 'pending',
    }))).rejects.toMatchObject({ cause: { code: '42501' } });

    const systemRows = await withSystemDbAccessContext(() => db.select({ kid: trustSigningKeys.kid }).from(trustSigningKeys));
    expect(systemRows).toEqual([{ kid: active.kid }]);
  });

  runDb('system scope can select and insert', async () => {
    await withSystemDbAccessContext(() => db.insert(trustSigningKeys).values({
      kid: 'trust-systeminsert0000',
      publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      privateKeyEnc: 'not-a-real-key',
      status: 'pending',
    }));
    const rows = await withSystemDbAccessContext(() => db.select({ kid: trustSigningKeys.kid, status: trustSigningKeys.status }).from(trustSigningKeys));
    expect(rows).toEqual([{ kid: 'trust-systeminsert0000', status: 'pending' }]);
  });

  runDb('the private-key CHECK refuses a signing-capable key without its private key', async () => {
    await expect(withSystemDbAccessContext(() => db.insert(trustSigningKeys).values({
      kid: 'trust-noprivatekey0000',
      publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      privateKeyEnc: null,
      status: 'active',
    }))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  runDb('two concurrent ensureActiveTrustSigningKey calls leave exactly one active row', async () => {
    const [a, b] = await Promise.all([ensureActiveTrustSigningKey(), ensureActiveTrustSigningKey()]);
    expect(a.kid).toBe(b.kid);
    const rows = await withSystemDbAccessContext(() =>
      db.select({ kid: trustSigningKeys.kid, status: trustSigningKeys.status }).from(trustSigningKeys));
    expect(rows.filter((r) => r.status === 'active')).toEqual([{ kid: a.kid, status: 'active' }]);
    expect(rows).toHaveLength(1);
  });

  runDb('the provisioned key round-trips through secretCrypto and the JWKS exposes only its public half', async () => {
    const active = await ensureActiveTrustSigningKey();
    const key = await loadTrustSigningKey(active.kid);
    expect(key.type).toBe('private');
    const jwks = await loadTrustJwks();
    expect(jwks.keys).toEqual([{ ...active.publicJwk, kid: active.kid, alg: 'ES256', use: 'sig' }]);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  const rows = () => withSystemDbAccessContext(() => db.select({
    kid: trustSigningKeys.kid, status: trustSigningKeys.status, hasPrivate: sql<boolean>`${trustSigningKeys.privateKeyEnc} IS NOT NULL`,
  }).from(trustSigningKeys));

  runDb('prepare → activate on Postgres: old key verify_only with its private key destroyed, new key signs', async () => {
    const old = await ensureActiveTrustSigningKey();
    const prepared = await prepareTrustSigningKey();
    expect((await loadTrustJwks()).keys.map((k) => k.kid).sort()).toEqual([old.kid, prepared.kid].sort());
    await activateTrustSigningKey(prepared.kid, { force: true });

    const after = await rows();
    expect(after).toEqual(expect.arrayContaining([
      { kid: old.kid, status: 'verify_only', hasPrivate: false },
      { kid: prepared.kid, status: 'active', hasPrivate: true },
    ]));
    expect((await ensureActiveTrustSigningKey()).kid).toBe(prepared.kid);
    await expect(loadTrustSigningKey(old.kid)).rejects.toBeInstanceOf(TrustAttestationUnavailable);
    expect((await loadTrustSigningKey(prepared.kid)).type).toBe('private');
    expect((await loadTrustJwks()).keys.map((k) => k.kid).sort()).toEqual([old.kid, prepared.kid].sort());
  });

  runDb('revoke --replace on Postgres: one transaction, exactly one active successor, the revoked key leaves the JWKS', async () => {
    const old = await ensureActiveTrustSigningKey();
    await revokeTrustSigningKey(old.kid, { replace: true });
    const after = await rows();
    expect(after.find((r) => r.kid === old.kid)).toEqual({ kid: old.kid, status: 'revoked', hasPrivate: false });
    const active = after.filter((r) => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.hasPrivate).toBe(true);
    expect((await loadTrustJwks()).keys.map((k) => k.kid)).toEqual([active[0]!.kid]);
  });

  runDb('revoke without --replace leaves no signer and never re-provisions', async () => {
    const old = await ensureActiveTrustSigningKey();
    await revokeTrustSigningKey(old.kid);
    await expect(ensureActiveTrustSigningKey()).rejects.toBeInstanceOf(TrustAttestationUnavailable);
    expect(await rows()).toEqual([{ kid: old.kid, status: 'revoked', hasPrivate: false }]);
  });

  runDb('two concurrent prepares leave exactly one pending key; the loser gets a TrustSigningKeyError', async () => {
    await ensureActiveTrustSigningKey();
    const results = await Promise.allSettled([prepareTrustSigningKey(), prepareTrustSigningKey()]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(TrustSigningKeyError);
    expect((await rows()).filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  runDb('the one-pending index refuses a second pending row at the storage layer', async () => {
    await prepareTrustSigningKey();
    await expect(withSystemDbAccessContext(() => db.insert(trustSigningKeys).values({
      kid: 'trust-secondpending000', publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, privateKeyEnc: 'not-a-real-key', status: 'pending',
    }))).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
