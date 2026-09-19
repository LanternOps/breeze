/**
 * #1374 (feature #4707, wave W01) — real-Postgres proof for the attestation
 * state added to `authenticator_devices` by
 * `2026-10-06-100101-authenticator-attestation-state.sql`.
 *
 * Why this must be an INTEGRATION suite: every assertion here is about what
 * Postgres itself accepts. The mocked unit suites (authenticatorAssurance.test,
 * authenticator.test) stub `../db` wholesale, so they cannot see the enum, the
 * column defaults, the classify-existing backfill, or the CHECK constraint —
 * a migration could ship any of them wrong and stay unit-green.
 *
 * The suite drives its writes through the SYSTEM db context because
 * `authenticator_devices` is tenancy shape 6 (user-id scoped) with FORCE RLS —
 * the cross-tenant forge proof for that policy already lives in
 * `authenticatorRls.integration.test.ts` and is not re-litigated here.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_PATH = join(
  __dirname,
  '../../../migrations/2026-10-06-100101-authenticator-attestation-state.sql',
);

const seededPartnerIds: string[] = [];

/** Seeds a partner/org/user and returns the user id (the shape-6 owner). */
async function seedUser(): Promise<string> {
  const partner = await createPartner({ name: `Attest ${Date.now()}-${Math.random()}` });
  seededPartnerIds.push(partner.id as string);
  const org = await createOrganization({ partnerId: partner.id as string, name: 'Attestation Co' });
  const user = await createUser({
    partnerId: partner.id as string,
    orgId: org.id as string,
    email: `attest-${Math.random().toString(36).slice(2)}@example.com`,
  });
  return user.id as string;
}

afterAll(async () => {
  // setup.ts TRUNCATEs core tenant tables between tests, so normally only the
  // last test's rows survive — this is a harmless FK-ordered superset.
  const db = getTestDb();
  for (const partnerId of seededPartnerIds) {
    await db.execute(sql`DELETE FROM users WHERE partner_id = ${partnerId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE partner_id = ${partnerId}::uuid`);
    await db.execute(sql`DELETE FROM partners WHERE id = ${partnerId}::uuid`);
  }
});

describe('authenticator_devices attestation state (migration 2026-10-06-100101)', () => {
  it('exposes the platform_bound_basis enum with exactly the expected labels, weakest first', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT e.enumlabel AS label
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'authenticator_platform_bound_basis'
      ORDER BY e.enumsortorder
    `)) as unknown as { label: string }[];
    expect(rows.map((r) => r.label)).toEqual([
      'unattested',
      'legacy_unattested',
      'webauthn_backup_flags',
      'ios_keychain_rsa_app_attest',
      'ios_se_p256_app_attest',
      'android_tee_key_attestation',
      'android_strongbox_key_attestation',
    ]);
  });

  it('adds every attestation column with the right nullability and default', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'authenticator_devices'
        AND column_name IN (
          'platform_bound_basis','attestation_verified_at','attestation_key_id',
          'attested_public_key_sha256','attestation_evidence',
          'app_integrity_verified_at','possession_verified_at'
        )
      ORDER BY column_name
    `)) as unknown as { column_name: string; is_nullable: string; column_default: string | null }[];
    expect(rows).toHaveLength(7);

    const basis = rows.find((r) => r.column_name === 'platform_bound_basis')!;
    expect(basis.is_nullable).toBe('NO');
    // A new row must land on the WEAKEST basis, never an attested one — the
    // default is what a forgotten explicit value falls back to.
    expect(basis.column_default).toContain("'unattested'");

    const evidence = rows.find((r) => r.column_name === 'attestation_evidence')!;
    expect(evidence.is_nullable).toBe('NO');
    expect(evidence.column_default).toContain('{}');

    // Everything else is nullable — an unattested row has nothing to record.
    for (const name of [
      'attestation_verified_at',
      'attestation_key_id',
      'attested_public_key_sha256',
      'app_integrity_verified_at',
      'possession_verified_at',
    ]) {
      expect(rows.find((r) => r.column_name === name)!.is_nullable).toBe('YES');
    }
  });

  it('defaults a freshly inserted row to unattested', async () => {
    const userId = await seedUser();
    const row = await withSystemDbAccessContext(async () => {
      const inserted = (await getTestDb().execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, public_key, is_platform_bound)
        VALUES (${userId}::uuid, 'mobile_hw_key', 'spki-b64', false)
        RETURNING platform_bound_basis, attestation_verified_at, attestation_evidence
      `)) as unknown as {
        platform_bound_basis: string;
        attestation_verified_at: Date | null;
        attestation_evidence: unknown;
      }[];
      return inserted[0]!;
    });
    expect(row.platform_bound_basis).toBe('unattested');
    expect(row.attestation_verified_at).toBeNull();
    expect(row.attestation_evidence).toEqual({});
  });

  it('rejects an attested basis that carries no attestation evidence (CHECK constraint)', async () => {
    const userId = await seedUser();
    // drizzle wraps the top-level message as "Failed query: ..." and surfaces
    // the postgres.js error on `.cause` — same convention as authenticatorRls.
    let caught: unknown;
    try {
      await withSystemDbAccessContext(async () =>
        getTestDb().execute(sql`
          INSERT INTO authenticator_devices (user_id, kind, public_key, is_platform_bound, platform_bound_basis)
          VALUES (${userId}::uuid, 'mobile_hw_key', 'spki-b64', true, 'ios_se_p256_app_attest')
        `),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string; constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe('authenticator_devices_attested_basis_chk');
    expect(cause?.message).toMatch(/violates check constraint/i);
  });

  it('accepts an attested basis once verified_at + the bound key digest are present', async () => {
    const userId = await seedUser();
    const row = await withSystemDbAccessContext(async () => {
      const inserted = (await getTestDb().execute(sql`
        INSERT INTO authenticator_devices (
          user_id, kind, public_key, is_platform_bound, platform_bound_basis,
          attestation_verified_at, attested_public_key_sha256, attestation_evidence
        )
        VALUES (
          ${userId}::uuid, 'mobile_hw_key', 'spki-b64', true, 'android_strongbox_key_attestation',
          now(), decode('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
          '{"keyMintSecurityLevel":"StrongBox"}'::jsonb
        )
        RETURNING platform_bound_basis
      `)) as unknown as { platform_bound_basis: string }[];
      return inserted[0]!;
    });
    expect(row.platform_bound_basis).toBe('android_strongbox_key_attestation');
  });

  // A derived basis has no attestation to time-stamp, so the constraint must
  // NOT demand one — otherwise every browser passkey registration 23514s.
  it('accepts webauthn_backup_flags with no attestation evidence', async () => {
    const userId = await seedUser();
    const row = await withSystemDbAccessContext(async () => {
      const inserted = (await getTestDb().execute(sql`
        INSERT INTO authenticator_devices (
          user_id, kind, public_key, credential_id, is_platform_bound, platform_bound_basis
        )
        VALUES (${userId}::uuid, 'webauthn_platform', 'spki-b64', ${`cred-${Math.random()}`}, true, 'webauthn_backup_flags')
        RETURNING platform_bound_basis, attestation_verified_at
      `)) as unknown as { platform_bound_basis: string; attestation_verified_at: Date | null }[];
      return inserted[0]!;
    });
    expect(row.platform_bound_basis).toBe('webauthn_backup_flags');
    expect(row.attestation_verified_at).toBeNull();
  });

  // The classify-existing backfill. Replayed by path against rows seeded to
  // look pre-migration, because the migration itself already ran in
  // globalSetup before any fixture existed.
  it('classifies pre-existing rows: mobile -> legacy_unattested, webauthn -> webauthn_backup_flags', async () => {
    const userId = await seedUser();
    const backfill = readFileSync(MIGRATION_PATH, 'utf8');
    // Extract only the classify block so the replay exercises the SHIPPED SQL
    // rather than a paraphrase of it.
    const classifyBlock = backfill.slice(
      backfill.indexOf('-- 3. Classify existing rows'),
      backfill.indexOf('-- 4. Integrity constraint'),
    );
    expect(classifyBlock).toContain('legacy_unattested');

    const rows = await withSystemDbAccessContext(async () => {
      const db = getTestDb();
      // Backdated on purpose: "pre-existing" now means created_at < the
      // migration's own ledger timestamp, not merely basis = 'unattested'.
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, public_key, is_platform_bound, platform_bound_basis, created_at)
        VALUES (${userId}::uuid, 'mobile_hw_key', 'legacy-mobile', true, 'unattested', now() - interval '30 days')
      `);
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, public_key, credential_id, is_platform_bound, platform_bound_basis, created_at)
        VALUES (${userId}::uuid, 'webauthn_platform', 'legacy-web', ${`cred-${Math.random()}`}, true, 'unattested', now() - interval '30 days')
      `);
      // A synced / backed-up passkey (is_platform_bound = false) must NOT be
      // labelled webauthn_backup_flags — that basis literally means
      // `singleDevice && !backedUp`, so the label would be false.
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, public_key, credential_id, is_platform_bound, platform_bound_basis, created_at)
        VALUES (${userId}::uuid, 'webauthn_platform', 'synced-web', ${`cred-synced-${Math.random()}`}, false, 'unattested', now() - interval '30 days')
      `);
      await db.execute(sql.raw(classifyBlock));
      return (await db.execute(sql`
        SELECT kind, public_key, platform_bound_basis, is_platform_bound
        FROM authenticator_devices
        WHERE user_id = ${userId}::uuid
        ORDER BY kind
      `)) as unknown as {
        kind: string;
        public_key: string;
        platform_bound_basis: string;
        is_platform_bound: boolean;
      }[];
    });

    const mobile = rows.find((r) => r.kind === 'mobile_hw_key')!;
    const web = rows.find((r) => r.public_key === 'legacy-web')!;
    const synced = rows.find((r) => r.public_key === 'synced-web')!;
    expect(synced.platform_bound_basis).toBe('unattested');
    expect(mobile.platform_bound_basis).toBe('legacy_unattested');
    expect(web.platform_bound_basis).toBe('webauthn_backup_flags');
    // The migration deliberately does NOT touch the boolean — the CODE
    // predicate is what refuses the basis, so the flip stays revertible via
    // BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED instead of a second migration.
    expect(mobile.is_platform_bound).toBe(true);
    expect(web.is_platform_bound).toBe(true);
  });

  // The replay hazard the classify predicate exists to close: after this wave
  // ships, EVERY new mobile registration legitimately writes
  // platform_bound_basis = 'unattested'. A classify step gated on the basis
  // alone would relabel those as legacy_unattested on any replay, corrupting
  // the forensic count the RAISE WARNINGs exist to produce.
  it('a replay does NOT relabel rows registered AFTER the migration applied', async () => {
    const userId = await seedUser();
    const full = readFileSync(MIGRATION_PATH, 'utf8');
    const rows = await withSystemDbAccessContext(async () => {
      const db = getTestDb();
      // Registered just now — i.e. after this migration's ledger timestamp.
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, public_key, is_platform_bound, platform_bound_basis)
        VALUES (${userId}::uuid, 'mobile_hw_key', 'brand-new-mobile', false, 'unattested')
      `);
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, public_key, credential_id, is_platform_bound, platform_bound_basis)
        VALUES (${userId}::uuid, 'webauthn_platform', 'brand-new-web', ${`cred-new-${Math.random()}`}, true, 'unattested')
      `);
      await db.execute(sql.raw(full));
      return (await db.execute(sql`
        SELECT public_key, platform_bound_basis
        FROM authenticator_devices
        WHERE user_id = ${userId}::uuid
      `)) as unknown as { public_key: string; platform_bound_basis: string }[];
    });
    expect(rows.find((r) => r.public_key === 'brand-new-mobile')!.platform_bound_basis).toBe(
      'unattested',
    );
    expect(rows.find((r) => r.public_key === 'brand-new-web')!.platform_bound_basis).toBe(
      'unattested',
    );
  });

  // The CHECK is an AND, not an OR: half the evidence is not evidence.
  it.each([
    ['only attestation_verified_at', sql`now(), NULL`],
    ['only attested_public_key_sha256', sql`NULL, ${Buffer.from([0])}::bytea`],
  ])('rejects an attested basis carrying %s', async (_label, values) => {
    const userId = await seedUser();
    let caught: unknown;
    try {
      await withSystemDbAccessContext(async () =>
        getTestDb().execute(sql`
          INSERT INTO authenticator_devices (
            user_id, kind, public_key, is_platform_bound, platform_bound_basis,
            attestation_verified_at, attested_public_key_sha256
          )
          VALUES (${userId}::uuid, 'mobile_hw_key', 'half-evidence', true, 'ios_se_p256_app_attest', ${values})
        `),
      );
    } catch (err) {
      caught = err;
    }
    expect(
      (caught as { cause?: { constraint_name?: string } } | undefined)?.cause?.constraint_name,
    ).toBe('authenticator_devices_attested_basis_chk');
  });

  // Re-applying a shipped migration must be a true no-op (CLAUDE.md).
  it('is idempotent — a full replay changes nothing', async () => {
    const userId = await seedUser();
    const full = readFileSync(MIGRATION_PATH, 'utf8');
    const after = await withSystemDbAccessContext(async () => {
      const db = getTestDb();
      await db.execute(sql`
        INSERT INTO authenticator_devices (
          user_id, kind, public_key, is_platform_bound, platform_bound_basis,
          attestation_verified_at, attested_public_key_sha256
        )
        VALUES (${userId}::uuid, 'mobile_hw_key', 'attested', true, 'ios_se_p256_app_attest', now(), '\\x00'::bytea)
      `);
      await db.execute(sql.raw(full));
      return (await db.execute(sql`
        SELECT platform_bound_basis FROM authenticator_devices WHERE user_id = ${userId}::uuid
      `)) as unknown as { platform_bound_basis: string }[];
    });
    // An already-attested row must NOT be reclassified to legacy_unattested by
    // a replay — that would strip L4 from a genuinely attested key.
    expect(after[0]!.platform_bound_basis).toBe('ios_se_p256_app_attest');
  });
});
