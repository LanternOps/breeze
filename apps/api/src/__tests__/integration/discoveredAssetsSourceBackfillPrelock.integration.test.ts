/**
 * Live-Postgres regression for the v0.111.0 US outage (Refs #5239).
 *
 * `2026-10-14-100100-discovered-assets-manual-source.sql` backfills
 * `discovered_assets.source` with two set-based UPDATEs in one transaction.
 * `discovered_assets` carries `breeze_partner_export_material_update` ->
 * `breeze_partner_export_site_child_update`, which unconditionally takes
 * `breeze_partner_export_lock_orgs_exclusive()` over EVERY org in the
 * statement's transition tables — and that helper takes the orgs' partners
 * (shared) first. The lock ledger is transaction-scoped
 * (`set_config(..., is_local => true)`), so the two statements share it: the
 * second one asks for a partner lock after org locks are already held and
 * raises P0001.
 *
 * This is not reproducible without a real database and real multi-tenant rows:
 * the whole failure lives in plpgsql trigger bodies and transaction-local
 * GUCs, and it needs `discovered_assets` rows spread over at least two
 * PARTNERS. CI's database has none, which is precisely why the bug shipped.
 *
 * The fixture is built so the failure is DETERMINISTIC rather than dependent
 * on how the random tenant UUIDs happen to sort:
 *
 *   - exactly one row (org A1, partner A) is UniFi-flagged, so statement 1's
 *     transition table contains only partner A's org;
 *   - the remaining NULL-source rows live in org A2 (partner A) AND in both of
 *     partner B's orgs, so statement 2 necessarily requests a lock on partner
 *     B — a NEW partner — while `breeze.partner_export_org_lock_held` is
 *     already '1'.
 *
 * Whichever way the UUIDs sort, that is the hierarchy violation.
 *
 * WHAT THIS COVERS / WHAT IT DOES NOT. `replayMigration` runs as the superuser
 * test client, so this suite proves the LOCK ORDER, not the
 * `set_config('breeze.scope','system', true)` elevation — that is covered
 * statically by `src/db/migrationRlsScope.test.ts` in the unit job.
 */
import './setup';

import { describe, expect, it, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createOrganization, createPartner, createSite } from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PRELOCK_MIGRATION = '2026-10-14-100050-discovered-assets-source-backfill-prelock.sql';
const SHIPPED_MIGRATION = '2026-10-14-100100-discovered-assets-manual-source.sql';

interface SeededTenants {
  orgA1: string;
  orgA2: string;
  orgB1: string;
  orgB2: string;
}

/**
 * The migration's own `ALTER COLUMN source SET NOT NULL` has already run on
 * this database (globalSetup applies the full migration set), so the
 * pre-migration state has to be recreated: drop the NOT NULL and the default
 * so NULL-source rows can exist again.
 *
 * The two CHECKs stay in place — every seeded row carries an `ip_address`, so
 * `discovered_assets_scan_requires_ip_chk` and
 * `discovered_assets_manual_identity_chk` are both satisfied with a NULL
 * `source`.
 */
async function openPreMigrationWindow(): Promise<void> {
  await getTestDb().execute(
    sql`ALTER TABLE public.discovered_assets ALTER COLUMN source DROP NOT NULL`,
  );
  await getTestDb().execute(
    sql`ALTER TABLE public.discovered_assets ALTER COLUMN source DROP DEFAULT`,
  );
}

/**
 * Always restore, in a `finally`: DDL here is global for the whole vitest
 * process, and a later suite in the same shard would otherwise see a nullable
 * `source` with no default. Seeded rows are DELETEd first — the DELETE
 * trigger only locks for `approved` rows of device-shaped asset types, and
 * every row below is `pending`, so the cleanup itself cannot deadlock.
 */
async function closePreMigrationWindow(): Promise<void> {
  await getTestDb().execute(sql`DELETE FROM public.discovered_assets WHERE source IS NULL`);
  await getTestDb().execute(
    sql`ALTER TABLE public.discovered_assets ALTER COLUMN source SET DEFAULT 'scan'`,
  );
  await getTestDb().execute(
    sql`ALTER TABLE public.discovered_assets ALTER COLUMN source SET NOT NULL`,
  );
}

/** Two partners, two orgs each, one site per org, one NULL-source asset per org. */
async function seedTwoPartnersFourOrgs(): Promise<SeededTenants> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();

  const orgs = {
    orgA1: (await createOrganization({ partnerId: partnerA.id })).id,
    orgA2: (await createOrganization({ partnerId: partnerA.id })).id,
    orgB1: (await createOrganization({ partnerId: partnerB.id })).id,
    orgB2: (await createOrganization({ partnerId: partnerB.id })).id,
  };

  let octet = 10;
  for (const [key, orgId] of Object.entries(orgs)) {
    const site = await createSite({ orgId });
    // Only org A1's row is UniFi-flagged: it is what makes statement 1 lock a
    // strict SUBSET of the partners statement 2 needs.
    const detectedTypeSource = key === 'orgA1' ? 'unifi_controller' : null;
    await getTestDb().execute(sql`
      INSERT INTO public.discovered_assets (org_id, site_id, ip_address, source, detected_type_source)
      VALUES (${orgId}::uuid, ${site.id}::uuid, ${`192.0.2.${octet}`}::inet, NULL,
              ${detectedTypeSource}::discovered_asset_detection_source)
    `);
    octet += 1;
  }

  return orgs;
}

async function sourceByOrg(orgs: SeededTenants): Promise<Record<string, string | null>> {
  const rows = (await getTestDb().execute(sql`
    SELECT org_id::text AS org_id, source::text AS source
      FROM public.discovered_assets
     WHERE org_id = ANY(ARRAY[${orgs.orgA1}, ${orgs.orgA2}, ${orgs.orgB1}, ${orgs.orgB2}]::uuid[])
  `)) as unknown as Array<{ org_id: string; source: string | null }>;

  const byOrgId = new Map(rows.map((row) => [row.org_id, row.source]));
  return {
    orgA1: byOrgId.get(orgs.orgA1) ?? null,
    orgA2: byOrgId.get(orgs.orgA2) ?? null,
    orgB1: byOrgId.get(orgs.orgB1) ?? null,
    orgB2: byOrgId.get(orgs.orgB2) ?? null,
  };
}

function causeOf(error: unknown): { code?: string; message?: string } {
  return (
    (error as { cause?: { code?: string; message?: string } }).cause ??
    (error as { code?: string; message?: string })
  );
}

describe('discovered_assets source backfill: partner/org lock pre-acquisition (#5239)', () => {
  afterEach(async () => {
    if (!process.env.DATABASE_URL) return;
    await closePreMigrationWindow();
  });

  runDb(
    'REGRESSION: the shipped backfill alone aborts with P0001 once assets span two partners',
    async () => {
      await openPreMigrationWindow();
      await seedTwoPartnersFourOrgs();

      let raised: unknown;
      try {
        await replayMigration(SHIPPED_MIGRATION);
      } catch (error) {
        raised = error;
      }

      expect(
        raised,
        'the shipped migration must still reproduce the outage on its own — ' +
          'if this is undefined the fixture stopped spanning two partners',
      ).toBeDefined();
      const cause = causeOf(raised);
      expect(cause.code).toBe('P0001');
      // Deterministic, not UUID-order-dependent: statement 2 spans BOTH
      // partners, so whichever of them sorts first, one of them is new while
      // `breeze.partner_export_org_lock_held` is already '1' — and the
      // hierarchy check runs before the ascending-order check. (Once the
      // partners happen to be pre-held, the SAME migration instead trips
      // 'organization locks must be acquired in ascending UUID order'; both
      // were observed in the outage.)
      expect(cause.message).toMatch(
        /partner export lock hierarchy violation: new partner lock requested after organization lock/,
      );
    },
  );

  runDb(
    'the pre-lock migration makes the shipped backfill succeed, with the right source distribution',
    async () => {
      await openPreMigrationWindow();
      const orgs = await seedTwoPartnersFourOrgs();

      await replayMigration(PRELOCK_MIGRATION);
      // The shipped file now finds nothing to backfill and completes, which is
      // exactly what happens on a real upgrade: 100050 sorts immediately ahead
      // of it.
      await replayMigration(SHIPPED_MIGRATION);

      expect(await sourceByOrg(orgs)).toEqual({
        orgA1: 'unifi',
        orgA2: 'scan',
        orgB1: 'scan',
        orgB2: 'scan',
      });
    },
  );

  runDb('the pre-lock migration is a no-op on an already-backfilled database', async () => {
    // No pre-migration window and no NULL sources: every lock helper is handed
    // an empty array and both UPDATEs match zero rows. This is the hosted-US
    // case, where the fix-forward SQL was already applied by hand.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    await getTestDb().execute(sql`
      INSERT INTO public.discovered_assets (org_id, site_id, ip_address)
      VALUES (${org.id}::uuid, ${site.id}::uuid, '198.51.100.7'::inet)
    `);

    await expect(replayMigration(PRELOCK_MIGRATION)).resolves.toBeUndefined();

    const rows = (await getTestDb().execute(sql`
      SELECT source::text AS source FROM public.discovered_assets WHERE org_id = ${org.id}::uuid
    `)) as unknown as Array<{ source: string }>;
    expect(rows.map((row) => row.source)).toEqual(['scan']);
  });
});
