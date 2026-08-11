/**
 * Functional forge proof for organization_external_links (#3242).
 *
 * Shape 1 (direct org_id): breeze_has_org_access(org_id) policies, enabled
 * and forced in 2026-08-08-organization-external-links.sql. These tests run
 * through the real driver as the unprivileged app role under the integration
 * config; do not run them with the plain unit-test Vitest config.
 *
 * Also proves:
 *  - the composite FK (org_id, partner_id) → organizations (id, partner_id)
 *    makes a drifted partner_id unrepresentable even under system scope;
 *  - the 2026-08-18 drop migration's DEFENSIVE re-backfill maps any surviving
 *    legacy accounting_* values into link rows before removing the columns,
 *    exactly once, and replaying the migration is a no-op.
 *
 * Fixtures are re-seeded per test — the integration setup truncates tenant
 * data between tests, so memoized fixtures would be stale and vacuous.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { organizationExternalLinks } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION_FILE = '2026-08-18-drop-organizations-accounting-columns.sql';

function migrationText(): string {
  return readFileSync(join(__dirname, '../../../migrations', MIGRATION_FILE), 'utf8');
}

function partnerCtx(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    return { partnerA, orgA, partnerB, orgB };
  });
}

async function captureCause(fn: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause) return cause;
    const direct = err as { code?: string; message?: string };
    return direct.code ? { code: direct.code, message: direct.message } : { message: direct.message };
  }
}

describe('organization_external_links RLS — org-axis forge (breeze_app role)', () => {
  // Non-vacuity guard: if the code-under-test pool is ever a BYPASSRLS role
  // (e.g. a worktree missing its .env.test symlink), every forge assertion
  // below passes even with broken policies. Fail loudly here first.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { partnerA, orgA } = await seedFixture();
    const rows = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  runDb('allows an accessible-org link insert and read-back', async () => {
    const { partnerA, orgA } = await seedFixture();

    const [row] = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
      db.insert(organizationExternalLinks).values({
        orgId: orgA.id,
        partnerId: partnerA.id,
        system: 'datto_rmm',
        externalId: 'ext-1',
      }).returning({ id: organizationExternalLinks.id })
    );
    expect(row?.id).toBeDefined();
  });

  runDb('rejects a cross-partner forge INSERT with an RLS violation (42501)', async () => {
    const { partnerA, orgA, partnerB, orgB } = await seedFixture();

    // Partner A's context forging a link row onto partner B's org.
    const cause = await captureCause(() =>
      withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
        db.insert(organizationExternalLinks).values({
          orgId: orgB.id,
          partnerId: partnerB.id,
          system: 'datto_rmm',
          externalId: 'forged',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/row-level security/);
  });

  runDb('hides another partner’s link rows from SELECT (org isolation)', async () => {
    const { partnerA, orgA, partnerB, orgB } = await seedFixture();

    await withSystemDbAccessContext(() =>
      db.insert(organizationExternalLinks).values({
        orgId: orgB.id,
        partnerId: partnerB.id,
        system: 'ninjaone',
        externalId: 'hidden-1',
      })
    );

    // Visible under system scope (non-vacuity of the seed)…
    const systemProbe = await withSystemDbAccessContext(() =>
      db.select({ id: organizationExternalLinks.id })
        .from(organizationExternalLinks)
        .where(eq(organizationExternalLinks.orgId, orgB.id))
    );
    expect(systemProbe.length).toBeGreaterThan(0);

    // …but invisible to partner A.
    const rows = await withDbAccessContext(partnerCtx(partnerA.id, [orgA.id]), () =>
      db.select({ id: organizationExternalLinks.id })
        .from(organizationExternalLinks)
        .where(eq(organizationExternalLinks.orgId, orgB.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('composite FK rejects a link row whose partner_id disagrees with the org (even as system)', async () => {
    const { orgA, partnerB } = await seedFixture();

    // System scope bypasses RLS, so the FK is the only guard being tested.
    const cause = await captureCause(() =>
      withSystemDbAccessContext(() =>
        db.insert(organizationExternalLinks).values({
          orgId: orgA.id,          // belongs to partner A
          partnerId: partnerB.id,  // drifted partner
          system: 'csv',
          externalId: 'drift-1',
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('23503'); // foreign_key_violation
  });

  runDb('unique index scopes (system, external_id) per partner — both partners can hold the same vendor UID', async () => {
    const { partnerA, orgA, partnerB, orgB } = await seedFixture();

    await withSystemDbAccessContext(async () => {
      await db.insert(organizationExternalLinks).values({
        orgId: orgA.id, partnerId: partnerA.id, system: 'datto_rmm', externalId: '12345',
      });
      await db.insert(organizationExternalLinks).values({
        orgId: orgB.id, partnerId: partnerB.id, system: 'datto_rmm', externalId: '12345',
      });
    });

    // Same partner + system + external id must be refused.
    const cause = await captureCause(() =>
      withSystemDbAccessContext(() =>
        db.insert(organizationExternalLinks).values({
          orgId: orgA.id, partnerId: partnerA.id, system: 'datto_rmm', externalId: '12345',
        })
      )
    );
    expect(cause?.code).toBe('23505'); // unique_violation
  });
});

/** Column names that must NOT exist on organizations after the drop migration. */
const LEGACY_COLUMNS = ['accounting_provider', 'accounting_external_id'] as const;

async function legacyColumnsPresent(): Promise<string[]> {
  const rows = await getTestDb().execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations'
      AND column_name IN ('accounting_provider', 'accounting_external_id')
  `) as unknown as Array<{ column_name: string }>;
  return rows.map((r) => r.column_name).sort();
}

describe('2026-08-18 drop of the legacy accounting columns', () => {
  runDb('the columns and their partial unique index are gone from the migrated schema', async () => {
    expect(await legacyColumnsPresent()).toEqual([]);
    const idx = await getTestDb().execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'organizations_accounting_external_uniq'
    `) as unknown as unknown[];
    expect(idx.length).toBe(0);
  });

  // The defensive re-backfill exists for a deployment that wrote the legacy pair
  // AFTER the 2026-08-08 backfill (an unmigrated code path, a manual UPDATE, or a
  // self-hoster jumping several versions). Recreate that state with raw SQL —
  // the Drizzle schema no longer knows these columns — and prove the drop
  // migration rescues the linkage instead of destroying it.
  runDb('re-backfills a legacy-only link before dropping, exactly once, and replays as a no-op', async () => {
    const { partnerA } = await seedFixture();
    const legacyOrg = await withSystemDbAccessContext(async () =>
      (await createOrganization({ partnerId: partnerA.id }))!
    );

    const countLinks = async () =>
      withSystemDbAccessContext(async () => {
        const rows = await db.select({ id: organizationExternalLinks.id })
          .from(organizationExternalLinks)
          .where(and(
            eq(organizationExternalLinks.orgId, legacyOrg.id),
            eq(organizationExternalLinks.system, 'quickbooks'),
            eq(organizationExternalLinks.externalId, 'qb-backfill-1'),
          ));
        return rows.length;
      });

    // DANGER: this test resurrects DROPPED COLUMNS on the SHARED integration
    // database. DDL commits immediately and the per-test TRUNCATE only removes
    // rows, while autoMigrate will not re-drop them (the drop migration is
    // already recorded in breeze_migrations). So a column left behind here
    // persists for every later run and reddens BOTH the sibling test above and
    // tenant-export-policy.integration.test.ts ("organizations.accounting_
    // provider: unclassified") until someone hand-drops it on the CI database.
    //
    // Everything from the setup DDL onwards therefore lives inside try/finally,
    // and the finally is UNCONDITIONAL — it must also run when the setup itself
    // fails halfway (the ADD COLUMNs are separate statements), when an
    // assertion throws, and when the test times out mid-flight.
    // Precedent: tenant-export-policy.integration.test.ts.
    try {
      // Put the database back into the pre-drop shape, then write a legacy-only link.
      await getTestDb().execute(sql`
        ALTER TABLE organizations ADD COLUMN IF NOT EXISTS accounting_provider text;
        ALTER TABLE organizations ADD COLUMN IF NOT EXISTS accounting_external_id text;
        CREATE UNIQUE INDEX IF NOT EXISTS organizations_accounting_external_uniq
          ON organizations (partner_id, accounting_provider, accounting_external_id)
          WHERE accounting_external_id IS NOT NULL;
      `);
      expect(await legacyColumnsPresent()).toEqual(LEGACY_COLUMNS.slice().sort());
      await getTestDb().execute(sql`
        UPDATE organizations
        SET accounting_provider = 'quickbooks', accounting_external_id = 'qb-backfill-1'
        WHERE id = ${legacyOrg.id}
      `);

      // The migration must rescue the linkage into the link table…
      await getTestDb().execute(sql.raw(migrationText()));
      expect(await countLinks()).toBe(1);
      // …and remove the columns + index in the same pass.
      expect(await legacyColumnsPresent()).toEqual([]);

      // Replaying against the already-dropped schema must be a clean no-op — the
      // backfill block is guarded on BOTH columns still existing, so it neither
      // throws nor duplicates the rescued row.
      await getTestDb().execute(sql.raw(migrationText()));
      expect(await countLinks()).toBe(1);
      expect(await legacyColumnsPresent()).toEqual([]);
    } finally {
      // Idempotent by construction: in the happy path the migration already
      // dropped all three objects, so this is a no-op.
      await getTestDb().execute(sql`
        DROP INDEX IF EXISTS organizations_accounting_external_uniq;
        ALTER TABLE organizations DROP COLUMN IF EXISTS accounting_provider;
        ALTER TABLE organizations DROP COLUMN IF EXISTS accounting_external_id;
      `);
    }
  });
});
