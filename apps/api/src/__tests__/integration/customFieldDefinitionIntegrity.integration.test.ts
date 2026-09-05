/**
 * custom_field_definitions integrity constraints — #3257 W02.
 *
 * Migration under test:
 * `2026-10-10-100300-custom-field-definition-integrity.sql`.
 *
 * The table shipped in the squashed baseline with a primary key and two
 * foreign keys and NOTHING else (0001-baseline.sql:6761-6766, 11891-11907; no
 * later migration adds an index). That leaves two defects that #3257's
 * definitions importer would industrialise:
 *
 *  1. **No unique key on `field_key`.** A definitions import therefore has no
 *     idempotency key, so re-running it mints a duplicate `udf7`. Two
 *     definitions sharing one key also make the partner export emit two
 *     records for one datum, because the identity hash includes `f.id`
 *     (routes/partnerApi/configuration.ts).
 *  2. **`(org_id, partner_id) = (NULL, NULL)` is structurally legal.** Such a
 *     row is invisible to every non-system caller AND survives org cascade
 *     forever, because the cascade deletes by `org_id`. A latent GDPR orphan.
 *
 * Every assertion here runs under SYSTEM scope on purpose. Under an org- or
 * partner-scoped context the dual-axis RLS WITH CHECK
 * (2026-06-11-i-custom-fields-dual-axis-rls.sql) rejects an ownerless row with
 * 42501 *before* the CHECK constraint is ever evaluated — see
 * `customFieldDefinitionsPartnerRls.integration.test.ts`, which asserts that
 * ordering explicitly. System scope short-circuits `breeze_has_org_access` to
 * TRUE, which is the only way to reach the constraint itself and prove the
 * table is safe even for a caller RLS does not stop (migrations, backfills,
 * and the importer's own system-context writes all run there).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-10-100300-custom-field-definition-integrity.sql',
);

/**
 * Replay the real migration by path (the repo's established shape — see
 * `alertNotificationSendIdentity.integration.test.ts`). `autoMigrate.test.ts`
 * asserts every such reference resolves, so a rename of the migration turns
 * into a unit-job failure rather than an ENOENT minutes into Integration Tests.
 *
 * Runs as the privileged test role, mirroring how migrations actually run.
 */
async function replayMigration(): Promise<void> {
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

/** Remove the constraint + indexes so dirty rows can be forged, as prod's would be. */
async function dropIntegrityObjects(): Promise<void> {
  await getTestDb().execute(sql`
    ALTER TABLE public.custom_field_definitions
      DROP CONSTRAINT IF EXISTS custom_field_definitions_one_owner_chk`);
  await getTestDb().execute(sql`DROP INDEX IF EXISTS custom_field_definitions_org_key_uq`);
  await getTestDb().execute(sql`DROP INDEX IF EXISTS custom_field_definitions_partner_key_uq`);
}

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const sys = <T>(fn: () => Promise<T>): Promise<T> => withDbAccessContext(SYSTEM_CTX, fn);

const createdKeys: string[] = [];

/** Insert a definition under system scope and remember its key for cleanup. */
function insertDefinition(values: {
  orgId?: string | null;
  partnerId?: string | null;
  name: string;
  fieldKey: string;
}): Promise<unknown> {
  createdKeys.push(values.fieldKey);
  return sys(() => db.execute(sql`
    INSERT INTO custom_field_definitions (org_id, partner_id, name, field_key, type)
    VALUES (
      ${values.orgId ?? null}::uuid,
      ${values.partnerId ?? null}::uuid,
      ${values.name},
      ${values.fieldKey},
      'text'
    )`));
}

afterEach(async () => {
  if (createdKeys.length === 0) return;
  const keys = [...new Set(createdKeys)];
  createdKeys.length = 0;
  // `inArray`, not a raw `= ANY(${keys}::text[])`. Drizzle's `sql` tag expands
  // an interpolated JS array into a parenthesized list of SEPARATE bound
  // parameters — `($1, $2, $3)` — not a Postgres array literal, so the
  // `::text[]` cast fails instead of matching anything. The SQLSTATE depends
  // on the element count, which makes it especially easy to misdiagnose:
  // 22P02 "malformed array literal" for one element (observed here), 42846
  // "cannot cast type record to text[]" for several. Not a postgres.js
  // limitation — the driver serializes a real array fine on its own.
  await sys(() => db.delete(customFieldDefinitions).where(
    inArray(customFieldDefinitions.fieldKey, keys),
  ));
});

/**
 * Assert a write failed with a specific SQLSTATE.
 *
 * Drizzle wraps driver errors in a DrizzleQueryError whose `.message` is only
 * "Failed query: ...", so a regex on the message silently matches nothing
 * useful — the real postgres.js error (carrying `.code`) hangs off `.cause`.
 * `pgErrorCode` walks that chain. Asserting the code is also strictly stronger
 * than a message match: 23505 (unique violation), 23514 (check violation) and
 * 42501 (RLS denial) are three different guarantees, and a message regex would
 * happily accept any of them — which is exactly how a test meant to prove the
 * CHECK ends up silently proving only that RLS said no.
 */
async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

describe('custom_field_definitions integrity constraints (#3257 W02)', () => {
  describe('unique field_key per owner', () => {
    it('rejects a second org-owned definition with the same field_key', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ orgId: org.id, name: 'Asset Tag', fieldKey: 'asset_tag' });

      await expectSqlState(
        () => insertDefinition({ orgId: org.id, name: 'Asset Tag Again', fieldKey: 'asset_tag' }),
        '23505',
      );
    });

    it('rejects a second partner-wide definition with the same field_key', async () => {
      const partner = await createPartner();

      await insertDefinition({ partnerId: partner.id, name: 'UDF 7', fieldKey: 'udf7' });

      await expectSqlState(
        () => insertDefinition({ partnerId: partner.id, name: 'UDF 7 dup', fieldKey: 'udf7' }),
        '23505',
      );
    });

    /**
     * Uniqueness is per-OWNER, not global: two customers of the same MSP must
     * both be able to define `asset_tag`. A blanket `UNIQUE (field_key)` would
     * break every multi-tenant partner on day one.
     *
     * This test does NOT discriminate the shipped partial-per-axis indexes
     * from a composite `UNIQUE (org_id, partner_id, field_key)` — both orgs
     * here carry distinct non-NULL `org_id`s, so neither design lets them
     * collide. The test that catches that particular "simplification" is
     * `rejects a second partner-wide definition with the same field_key`
     * above: under a composite, every partner-wide row has `org_id NULL`,
     * btree treats NULLs as distinct, and the partner axis would enforce
     * nothing at all.
     */
    it('scopes uniqueness to ONE owner — two different orgs may both define asset_tag', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ orgId: orgA.id, name: 'Asset Tag', fieldKey: 'shared_asset_tag' });
      await insertDefinition({ orgId: orgB.id, name: 'Asset Tag', fieldKey: 'shared_asset_tag' });

      const rows = await sys(() => db.execute(sql`
        SELECT org_id FROM custom_field_definitions WHERE field_key = 'shared_asset_tag'`));
      expect(rows).toHaveLength(2);
    });

    /**
     * The org axis and the partner axis are independent indexes, so an
     * org-owned `udf7` and a partner-wide `udf7` can coexist at the DB level.
     * That collision is real but is NOT this migration's job: W03 adds the
     * cross-axis anti-shadowing trigger. Pinning it here documents the
     * boundary so W03's own red test is unambiguous about what changed.
     */
    it('does NOT (yet) block an org-owned key that shadows a partner-wide one — that is W03', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await insertDefinition({ partnerId: partner.id, name: 'UDF 9', fieldKey: 'udf9_shadow' });
      await insertDefinition({ orgId: org.id, name: 'UDF 9 org override', fieldKey: 'udf9_shadow' });

      const rows = await sys(() => db.execute(sql`
        SELECT id FROM custom_field_definitions WHERE field_key = 'udf9_shadow'`));
      expect(rows).toHaveLength(2);
    });
  });

  describe('org XOR partner ownership', () => {
    it('rejects an ownerless (NULL, NULL) row', async () => {
      await expectSqlState(
        () => insertDefinition({ name: 'Orphan', fieldKey: 'orphan_key' }),
        '23514',
      );
    });

    it('rejects a row claiming BOTH owners', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await expectSqlState(
        () => insertDefinition({
          orgId: org.id,
          partnerId: partner.id,
          name: 'Both',
          fieldKey: 'both_key',
        }),
        '23514',
      );
    });

    /**
     * The CHECK must hold on UPDATE too, not just INSERT. A row that starts
     * legitimately org-owned and is then NULLed out by a buggy repoint would
     * otherwise become the same invisible GDPR orphan the INSERT path now
     * refuses to create.
     */
    it('rejects an UPDATE that strips the only owner off an existing row', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      await insertDefinition({ orgId: org.id, name: 'Owned', fieldKey: 'update_orphan_key' });

      await expectSqlState(
        () => sys(() => db.execute(sql`
          UPDATE custom_field_definitions
             SET org_id = NULL
           WHERE field_key = 'update_orphan_key'`)),
        '23514',
      );
    });
  });

  /**
   * The migration's own abort path. This is the guard standing between a dirty
   * prod database and a deploy, and nothing else in this suite exercises it:
   * by the time any other test runs, autoMigrate has already applied the file
   * once, cleanly, against an empty table.
   *
   * It matters because the failure is asymmetric. `RAISE WARNING` alone would
   * return SUCCESS and autoMigrate would record the file as applied FOREVER
   * (it wraps each file in `client.begin`; only an exception rolls that back),
   * leaving prod permanently without the constraint while the ledger claims
   * otherwise. So the file WARNs the detail and then RAISEs — and that pairing
   * is what these tests pin. Deleting either RAISE fails one of them.
   *
   * Each test restores the shipped state in `finally` by replaying the same
   * migration, which doubles as a live proof that re-application is a true
   * no-op (the pg_constraint guard skips; both indexes are IF NOT EXISTS).
   */
  describe('deploy abort on pre-existing bad data', () => {
    it('aborts with P0001 and names the offending (owner, field_key) pairs', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      try {
        await dropIntegrityObjects();
        await insertDefinition({ orgId: org.id, name: 'Asset Tag', fieldKey: 'dirty_dupe' });
        await insertDefinition({ orgId: org.id, name: 'Asset Tag 2', fieldKey: 'dirty_dupe' });

        let raised: unknown;
        try {
          await replayMigration();
        } catch (err) {
          raised = err;
        }

        expect(raised, 'the migration must ABORT, not warn and continue').toBeDefined();
        expect(pgErrorCode(raised)).toBe('P0001');
        // The operator must be able to act on this without running a second
        // query, so the message carries the count and the remediation rule.
        const detail = JSON.stringify(raised);
        expect(detail).toMatch(/duplicate \(owner, field_key\) pairs/);
        expect(detail).toMatch(/resolve them by hand before deploying/);
      } finally {
        await sys(() => db.delete(customFieldDefinitions).where(
          inArray(customFieldDefinitions.fieldKey, ['dirty_dupe']),
        ));
        await replayMigration();
      }
    });

    it('aborts with P0001 on a pre-existing ownerless row', async () => {
      try {
        await dropIntegrityObjects();
        await insertDefinition({ name: 'Orphan', fieldKey: 'dirty_orphan' });

        let raised: unknown;
        try {
          await replayMigration();
        } catch (err) {
          raised = err;
        }

        expect(raised, 'the migration must ABORT, not warn and continue').toBeDefined();
        expect(pgErrorCode(raised)).toBe('P0001');
        expect(JSON.stringify(raised)).toMatch(/org XOR partner rule/);
      } finally {
        await sys(() => db.delete(customFieldDefinitions).where(
          inArray(customFieldDefinitions.fieldKey, ['dirty_orphan']),
        ));
        await replayMigration();
      }
    });

    it('re-applies cleanly, leaving the constraint and both indexes in place', async () => {
      await replayMigration();

      const objects = await sys(() => db.execute(sql`
        SELECT conname AS name FROM pg_constraint
         WHERE conname = 'custom_field_definitions_one_owner_chk'
        UNION ALL
        SELECT indexname FROM pg_indexes
         WHERE indexname IN ('custom_field_definitions_org_key_uq',
                             'custom_field_definitions_partner_key_uq')`));
      expect(objects).toHaveLength(3);
    });
  });
});
