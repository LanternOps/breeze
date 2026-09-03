/**
 * #1374 (feature #4707, wave W02) — real-Postgres proof for
 * `2026-10-06-120000-authenticator-public-key-alg.sql`.
 *
 * Why this must be an INTEGRATION suite: the unit suites stub `../db`
 * wholesale, so none of them can see the column default, the NOT NULL, or the
 * CHECK that bounds the algorithm domain. A migration could ship any of those
 * wrong and stay unit-green — which matters here because `public_key_alg` is
 * read on the approval path to decide HOW a signature is verified, and a row
 * carrying an unrecognised label is a row nothing can verify.
 *
 * Writes go through the SYSTEM db context: `authenticator_devices` is tenancy
 * shape 6 (user-id scoped) with FORCE RLS, and the cross-tenant forge proof for
 * that policy lives in `authenticatorRls.integration.test.ts` — not re-litigated
 * here.
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
  '../../../migrations/2026-10-06-120000-authenticator-public-key-alg.sql',
);

const seededPartnerIds: string[] = [];

async function seedUser(): Promise<string> {
  const partner = await createPartner({ name: `KeyAlg ${Date.now()}-${Math.random()}` });
  seededPartnerIds.push(partner.id as string);
  const org = await createOrganization({ partnerId: partner.id as string, name: 'Key Alg Co' });
  const user = await createUser({
    partnerId: partner.id as string,
    orgId: org.id as string,
    email: `keyalg-${Math.random().toString(36).slice(2)}@example.com`,
  });
  return user.id as string;
}

afterAll(async () => {
  const db = getTestDb();
  for (const partnerId of seededPartnerIds) {
    await db.execute(sql`DELETE FROM users WHERE partner_id = ${partnerId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE partner_id = ${partnerId}::uuid`);
    await db.execute(sql`DELETE FROM partners WHERE id = ${partnerId}::uuid`);
  }
});

describe('authenticator_devices.public_key_alg (migration 2026-10-06-120000)', () => {
  it('is NOT NULL and defaults to RS256 — every pre-W02 key is react-native-biometrics RSA', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT is_nullable, column_default, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'authenticator_devices' AND column_name = 'public_key_alg'
    `)) as unknown as {
      is_nullable: string;
      column_default: string | null;
      data_type: string;
      character_maximum_length: number;
    }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.column_default).toContain("'RS256'");
    expect(rows[0]!.data_type).toBe('character varying');
    expect(rows[0]!.character_maximum_length).toBe(16);
  });

  it('accepts both supported algorithms, and an insert that omits it lands on RS256', async () => {
    const userId = await seedUser();
    await withSystemDbAccessContext(async (db) => {
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, label, public_key, is_platform_bound)
        VALUES (${userId}::uuid, 'mobile_hw_key', 'legacy', 'spki-rsa', false)
      `);
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, label, public_key, is_platform_bound, public_key_alg)
        VALUES (${userId}::uuid, 'mobile_hw_key', 'attested', 'spki-ec', false, 'ES256')
      `);

      const rows = (await db.execute(sql`
        SELECT label, public_key_alg FROM authenticator_devices
        WHERE user_id = ${userId}::uuid ORDER BY label
      `)) as unknown as { label: string; public_key_alg: string }[];

      expect(rows.map((r) => [r.label, r.public_key_alg])).toEqual([
        ['attested', 'ES256'],
        ['legacy', 'RS256'],
      ]);
    });
  });

  it('REJECTS an unrecognised algorithm at the database, not merely in application code', async () => {
    // toMobileKeyAlg() fails closed on an unknown label, so such a row could
    // never satisfy an approval. It should not be storable in the first place.
    const userId = await seedUser();
    await withSystemDbAccessContext(async (db) => {
      await expect(
        db.execute(sql`
          INSERT INTO authenticator_devices (user_id, kind, label, public_key, is_platform_bound, public_key_alg)
          VALUES (${userId}::uuid, 'mobile_hw_key', 'bad', 'spki', false, 'HS256')
        `),
      ).rejects.toThrow(/authenticator_devices_public_key_alg_chk|violates check constraint/i);
    });
  });

  it('re-applies as a true no-op (idempotent), preserving an existing ES256 row', async () => {
    // autoMigrate keys `breeze_migrations` on filename; a replay must not reset
    // a classified row back to the default.
    const userId = await seedUser();
    await withSystemDbAccessContext(async (db) => {
      await db.execute(sql`
        INSERT INTO authenticator_devices (user_id, kind, label, public_key, is_platform_bound, public_key_alg)
        VALUES (${userId}::uuid, 'mobile_hw_key', 'attested', 'spki-ec', false, 'ES256')
      `);
    });

    const full = readFileSync(MIGRATION_PATH, 'utf8');
    await getTestDb().execute(sql.raw(full));
    await getTestDb().execute(sql.raw(full));

    await withSystemDbAccessContext(async (db) => {
      const rows = (await db.execute(sql`
        SELECT public_key_alg FROM authenticator_devices WHERE user_id = ${userId}::uuid
      `)) as unknown as { public_key_alg: string }[];
      expect(rows.map((r) => r.public_key_alg)).toEqual(['ES256']);
    });
  });
});
