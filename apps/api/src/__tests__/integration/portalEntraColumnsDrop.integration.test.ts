/**
 * Portal registration W10 (#11387) PR-B: drop the legacy portal_users Entra
 * objects (2027-01-28-220000-portal-users-drop-entra-columns.sql).
 *
 * Every case runs inside ONE superuser postgres.js transaction that is always
 * rolled back. It puts the legacy objects back (fixtures/
 * portalUsersLegacyEntraColumns.ts), seeds rows, executes the file exactly as
 * autoMigrate would, and the ROLLBACK leaves the fresh-migrated schema (where
 * the file already ran once) untouched. Template:
 * aiModelRegistryLegacyDrop.integration.test.ts.
 *
 * Proven (plan D2 and the §6 invariants this wave touches):
 *  - the two columns, the partial unique index, the fill trigger and its
 *    function are all gone, and the per-bucket counts are reported;
 *  - inv. 5: a legacy pair whose identity was removed (an N-era MSP removal)
 *    is never resurrected: the drop writes no identity row;
 *  - inv. 9: once the trigger is gone, no default grants browser access, and
 *    an insert without browser_access fails 23502;
 *  - re-apply is a no-op, and a partly-dropped set is never refused.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';
import { RESTORE_PORTAL_USERS_FILL_TRIGGER_SQL, RESTORE_PORTAL_USERS_LEGACY_ENTRA_SQL } from './fixtures/portalUsersLegacyEntraColumns';

const MIGRATION = '2027-01-28-220000-portal-users-drop-entra-columns.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
const entraIssuer = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

async function inRolledBackTx(body: (tx: Tx, notices: string[]) => Promise<void>, opts: { restore?: boolean } = {}): Promise<void> {
  const notices: string[] = [];
  const client = postgres(DATABASE_URL, { max: 1, onnotice: (n) => { notices.push(`${n.severity}: ${n.message}`); } });
  try {
    await client.begin(async (tx) => {
      if (opts.restore !== false) {
        await (tx as unknown as Tx).unsafe(RESTORE_PORTAL_USERS_LEGACY_ENTRA_SQL + RESTORE_PORTAL_USERS_FILL_TRIGGER_SQL);
      }
      await body(tx as unknown as Tx, notices);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function legacyObjects(tx: Tx) {
  const [row] = await tx<{ columns: number; index: boolean; trigger: boolean; fn: boolean }[]>`SELECT
    (SELECT count(*)::int FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'portal_users'
        AND column_name IN ('entra_oid', 'entra_tenant_id')) AS columns,
    to_regclass('public.portal_users_entra_identity_uniq') IS NOT NULL AS index,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.portal_users'::regclass
              AND tgname = 'portal_users_browser_access_fill') AS trigger,
    to_regprocedure('public.breeze_portal_users_fill_browser_access()') IS NOT NULL AS fn`;
  return row!;
}

async function newOrg(): Promise<string> {
  const partner = await createPartner();
  return (await createOrganization({ partnerId: partner.id })).id;
}

async function seedLogin(tx: Tx, orgId: string, pair: { tid: string | null; oid: string | null }) {
  const id = randomUUID();
  await tx`
    INSERT INTO portal_users (id, org_id, email, auth_method, status, browser_access, entra_oid, entra_tenant_id)
    VALUES (${id}, ${orgId}, ${`${id}@w10-drop.test`}, 'entra', 'active', 'none', ${pair.oid}, ${pair.tid})`;
  return id;
}

describe(MIGRATION, () => {
  it('starts with the system-scope line', async () => {
    const text = await loadMigration();
    const firstStatement = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
  });

  it('the fresh-migrated schema has none of the legacy objects (the file ran in autoMigrate)', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await legacyObjects(tx)).toEqual({ columns: 0, index: false, trigger: false, fn: false });
    }, { restore: false });
  });

  it('reports the per-bucket counts, then drops the columns, the index, the trigger and its function', async () => {
    const orgId = await newOrg();
    const tid = randomUUID();
    await inRolledBackTx(async (tx, notices) => {
      expect(await legacyObjects(tx)).toEqual({ columns: 2, index: true, trigger: true, fn: true });
      await seedLogin(tx, orgId, { tid, oid: randomUUID() }); // missing identity
      const orphan = await seedLogin(tx, orgId, { tid: null, oid: null });
      await tx`INSERT INTO portal_user_identities (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via)
               VALUES (${orgId}, ${orphan}, 'entra', ${entraIssuer(tid)}, ${randomUUID()}, ${tid}, 'jit')`;
      await seedLogin(tx, orgId, { tid: null, oid: randomUUID() }); // half-populated

      await tx.unsafe(await loadMigration());

      expect(await legacyObjects(tx)).toEqual({ columns: 0, index: false, trigger: false, fn: false });
      expect(notices.some((n) => /missing_identity=1 orphan_identity=1 mismatched=0 half_populated=1/.test(n))).toBe(true);
      expect(notices.some((n) => /WARNING: portal_users: dropping 1 legacy Entra pair\(s\) with no identity row/.test(n))).toBe(true);
      expect(notices.some((n) => /WARNING: portal_users: dropping 1 half-populated legacy Entra row/.test(n))).toBe(true);
    });
  });

  it('inv. 5: a removed identity is never resurrected by the drop (report, never repair)', async () => {
    const orgId = await newOrg();
    const tid = randomUUID();
    const oid = randomUUID();
    await inRolledBackTx(async (tx) => {
      // What release N leaves behind after an MSP removes a directory-disabled identity.
      const removed = await seedLogin(tx, orgId, { tid, oid });
      const [before] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM portal_user_identities`;

      await tx.unsafe(await loadMigration());

      const [after] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM portal_user_identities`;
      expect(after!.n).toBe(before!.n);
      const held = await tx`SELECT 1 FROM portal_user_identities WHERE issuer = ${entraIssuer(tid)} AND subject = ${oid}`;
      expect(held).toHaveLength(0);
      const [login] = await tx<{ status: string }[]>`SELECT status FROM portal_users WHERE id = ${removed}`;
      expect(login).toEqual({ status: 'active' });
    });
  });

  it('inv. 9: no default grants browser access after the trigger is gone — an insert without browser_access fails 23502', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx) => {
      await tx.unsafe(await loadMigration());
      let error: { code?: string; column_name?: string } | null = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp`INSERT INTO portal_users (org_id, email, auth_method) VALUES (${orgId}, ${`${randomUUID()}@w10-drop.test`}, 'password')`;
        });
      } catch (e) {
        error = e as typeof error;
      }
      expect(error).toMatchObject({ code: '23502', column_name: 'browser_access' });
    });
  });

  it('a re-apply is a no-op, and a partly-dropped set is never refused', async () => {
    await inRolledBackTx(async (tx, notices) => {
      await tx.unsafe(await loadMigration());
      notices.length = 0;
      await tx.unsafe(await loadMigration());
      expect(notices.some((n) => /already dropped \(or partly\): nothing to report/.test(n))).toBe(true);
      expect(await legacyObjects(tx)).toEqual({ columns: 0, index: false, trigger: false, fn: false });
    });
    await inRolledBackTx(async (tx) => {
      await tx.unsafe('DROP INDEX public.portal_users_entra_identity_uniq; ALTER TABLE public.portal_users DROP COLUMN entra_oid');
      await tx.unsafe(await loadMigration());
      expect(await legacyObjects(tx)).toEqual({ columns: 0, index: false, trigger: false, fn: false });
    });
  });
});
