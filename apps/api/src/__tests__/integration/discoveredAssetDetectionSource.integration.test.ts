/**
 * Real-DB behavioural test for the classifier-precedence guard (#3187).
 *
 * Two AUTOMATIC classifiers write `discovered_assets`: the UniFi controller
 * sync (which knows the exact model) and the agent network scan (which, when
 * its own classification comes up empty, guesses from the MAC OUI vendor
 * string). Both used to stamp `type_source='auto'`, so neither could tell it
 * was about to clobber the other — a UniFi *switch* was rewritten to
 * `access_point` by the OUI guess on the next scan and back to `switch` on the
 * next sync, flapping `detected_asset_type` forever.
 *
 * `detected_type_source` ranks those classifiers, and the guard is expressed as
 * SQL by `buildClassificationWrite` so it is evaluated by Postgres at write
 * time rather than from a stale JS read.
 *
 * Mocked unit tests cannot verify any of the parts that actually matter here,
 * which is why this file exists alongside them:
 *   - whether the untyped bind parameters in the rank CASE unify with the
 *     `discovered_asset_detection_source` enum column at all (a mis-typed CASE
 *     is a runtime 42804, invisible to a mock that never executes SQL),
 *   - whether the explicit `::discovered_asset_detection_source` cast resolves,
 *   - whether a target-table-qualified reference inside `UPDATE ... SET` reads
 *     the PRE-update row, which is the entire mechanism of the guard,
 *   - whether `else 0` genuinely ranks a NULL stored source below every real one.
 * The mocked suites pin the statement we build; this one pins what Postgres does
 * with it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite } from './db-utils';
import { discoveredAssets, devices } from '../../db/schema';
import { unifiIntegrations, unifiSiteMappings, unifiDevices } from '../../db/schema/unifi';
import {
  buildClassificationWrite,
  DISCOVERED_ASSET_DETECTION_SOURCES,
  type DiscoveredAssetDetectionSource,
} from '../../services/discoveredAssetClassification';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-20-discovered-asset-detection-source.sql',
);

/**
 * Pull JUST the backfill `DO $$ ... END $$;` block out of the shipped
 * migration file, rather than retyping it, so the test is pinned to the
 * ACTUAL SQL that ships — an inverted `IS NULL`, a wrong join column, or a
 * dropped `detected_asset_type IS NOT NULL` guard fails this test without
 * anyone having to remember to update a hand-copied statement.
 *
 * The file has exactly two `DO $$` blocks: the first `CREATE TYPE`, the
 * second the backfill. `lastIndexOf` picks the second; the sanity assertions
 * in the test below guard against this slicing silently drifting if the file
 * is ever restructured.
 */
function extractBackfillBlock(migrationSql: string): string {
  const start = migrationSql.lastIndexOf('DO $$');
  if (start === -1) {
    throw new Error(`no "DO $$" block found in ${MIGRATION_FILE}`);
  }
  const endMarker = 'END $$;';
  const endIdx = migrationSql.indexOf(endMarker, start);
  if (endIdx === -1) {
    throw new Error(`no closing "END $$;" found after backfill DO block in ${MIGRATION_FILE}`);
  }
  return migrationSql.slice(start, endIdx + endMarker.length);
}

const DEVICE_IP = '10.88.0.7';
const DEVICE_MAC = 'aa:bb:cc:77:88:99';

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { org, site };
}

async function seedAsset(
  orgId: string,
  siteId: string,
  overrides: Record<string, unknown>,
) {
  const db = getTestDb() as any;
  const [row] = await db
    .insert(discoveredAssets)
    .values({
      orgId,
      siteId,
      ipAddress: DEVICE_IP,
      macAddress: DEVICE_MAC,
      ...overrides,
    })
    .returning({ id: discoveredAssets.id });
  return row;
}

async function readAsset(id: string) {
  const db = getTestDb() as any;
  const [row] = await db
    .select({
      assetType: discoveredAssets.assetType,
      typeSource: discoveredAssets.typeSource,
      detectedAssetType: discoveredAssets.detectedAssetType,
      detectedTypeSource: discoveredAssets.detectedTypeSource,
    })
    .from(discoveredAssets)
    .where(eq(discoveredAssets.id, id));
  return row;
}

/**
 * Run the real guarded write the way a classifier does, against real Postgres.
 * This is the exact statement shape both `discoveryWorker.processResults` and
 * `unifiSyncService.reconcileDiscoveredAsset` build on their UPDATE branch.
 */
async function classify(
  assetId: string,
  source: DiscoveredAssetDetectionSource,
  proposedType: string,
) {
  const db = getTestDb() as any;
  await db
    .update(discoveredAssets)
    .set(
      buildClassificationWrite(source, {
        assetType: sql`${proposedType}`,
        detectedAssetType: sql`${proposedType}`,
      }),
    )
    .where(eq(discoveredAssets.id, assetId));
}

describe('discovered_assets classifier precedence (#3187)', () => {
  it('the headline regression: an OUI guess cannot rewrite a UniFi switch to access_point', async () => {
    const { org, site } = await seedOrg();
    // The UniFi controller read the model and said "switch".
    const asset = await seedAsset(org.id, site.id, {
      assetType: 'switch',
      typeSource: 'auto',
      detectedAssetType: 'switch',
      detectedTypeSource: 'unifi_controller',
    });

    // The next agent scan can only see "Ubiquiti" on the wire and guesses AP.
    await classify(asset.id, 'vendor_oui', 'access_point');

    const row = await readAsset(asset.id);
    // Nothing moved: not the user-facing type, not the latent one, not the source.
    expect(row.assetType).toBe('switch');
    expect(row.detectedAssetType).toBe('switch');
    expect(row.detectedTypeSource).toBe('unifi_controller');
  });

  it('a rejected write leaves the row byte-identical rather than NULLing the columns', async () => {
    const { org, site } = await seedOrg();
    const asset = await seedAsset(org.id, site.id, {
      assetType: 'switch',
      typeSource: 'auto',
      detectedAssetType: 'switch',
      detectedTypeSource: 'unifi_controller',
    });

    await classify(asset.id, 'vendor_oui', 'access_point');

    const row = await readAsset(asset.id);
    // The `else` arms of every CASE must re-select the EXISTING column. An
    // `else null` typo would still "preserve" nothing and would pass a test
    // that only asserted "not access_point".
    expect(row.detectedAssetType).not.toBeNull();
    expect(row.detectedTypeSource).not.toBeNull();
    expect(row.assetType).not.toBeNull();
  });

  it('a stronger classifier DOES overwrite a weaker one', async () => {
    const { org, site } = await seedOrg();
    // A previous scan guessed from the vendor string alone.
    const asset = await seedAsset(org.id, site.id, {
      assetType: 'access_point',
      typeSource: 'auto',
      detectedAssetType: 'access_point',
      detectedTypeSource: 'vendor_oui',
    });

    // The controller now reports the real model.
    await classify(asset.id, 'unifi_controller', 'switch');

    const row = await readAsset(asset.id);
    expect(row.assetType).toBe('switch');
    expect(row.detectedAssetType).toBe('switch');
    expect(row.detectedTypeSource).toBe('unifi_controller');
  });

  it('a classifier can refresh its OWN previous answer (the guard is <=, not <)', async () => {
    const { org, site } = await seedOrg();
    // Same source, changed reality: the box was re-provisioned as a gateway.
    const asset = await seedAsset(org.id, site.id, {
      assetType: 'switch',
      typeSource: 'auto',
      detectedAssetType: 'switch',
      detectedTypeSource: 'unifi_controller',
    });

    await classify(asset.id, 'unifi_controller', 'router');

    const row = await readAsset(asset.id);
    expect(row.assetType).toBe('router');
    expect(row.detectedAssetType).toBe('router');
  });

  it('a NULL detected_type_source ranks below every source, so the first classifier wins', async () => {
    const { org, site } = await seedOrg();
    // A row from before this column existed, or one nothing has classified.
    const asset = await seedAsset(org.id, site.id, {
      assetType: 'unknown',
      typeSource: 'auto',
    });
    expect((await readAsset(asset.id)).detectedTypeSource).toBeNull();

    // Even the weakest classifier may claim it — `else 0` in the rank CASE.
    await classify(asset.id, 'vendor_oui', 'printer');

    const row = await readAsset(asset.id);
    expect(row.assetType).toBe('printer');
    expect(row.detectedAssetType).toBe('printer');
    expect(row.detectedTypeSource).toBe('vendor_oui');
  });

  it('a manual type outranks even the authoritative classifier, but provenance still updates', async () => {
    const { org, site } = await seedOrg();
    const asset = await seedAsset(org.id, site.id, {
      assetType: 'nas',           // what the user pinned
      typeSource: 'manual',
      detectedAssetType: 'access_point',
      detectedTypeSource: 'vendor_oui',
    });

    await classify(asset.id, 'unifi_controller', 'switch');

    const row = await readAsset(asset.id);
    // The user's choice is untouched — the two axes compose, they don't race.
    expect(row.assetType).toBe('nas');
    expect(row.typeSource).toBe('manual');
    // ...but the latent columns still advance, so "reset to auto" restores the
    // BEST machine answer rather than the stale guess underneath the override.
    expect(row.detectedAssetType).toBe('switch');
    expect(row.detectedTypeSource).toBe('unifi_controller');
  });

  it('every enum member the code knows about is accepted by the database', async () => {
    // Guards against the TS union and the pg enum drifting apart: a member
    // added to one but not the other fails here with 22P02, not in production.
    const { org, site } = await seedOrg();
    for (const source of DISCOVERED_ASSET_DETECTION_SOURCES) {
      const asset = await seedAsset(org.id, site.id, {
        ipAddress: `10.88.9.${DISCOVERED_ASSET_DETECTION_SOURCES.indexOf(source) + 1}`,
        macAddress: null,
        detectedTypeSource: source,
      });
      expect((await readAsset(asset.id)).detectedTypeSource).toBe(source);
    }
  });

  it('the database enum has no member the rank map does not know about', async () => {
    // The reverse direction of the test above, and the one that actually bites:
    // a migration can add a label to `discovered_asset_detection_source` without
    // touching the TS union, and NOTHING would fail loudly. Rows carrying the
    // unknown label would then fall to `else 0` in the rank CASE — ranked below
    // every real source — so the weakest classifier could overwrite what should
    // have been protected. That is #3187 reintroduced through enum drift, and it
    // is silent. The Record<> in discoveredAssetClassification.ts only catches
    // the TS-side omission; this catches the SQL side.
    const db = getTestDb() as any;
    const rows = await db.execute(sql`
      select e.enumlabel::text as label
        from pg_enum e
        join pg_type t on t.oid = e.enumtypid
       where t.typname = 'discovered_asset_detection_source'
    `);
    const dbLabels = (rows as Array<{ label: string }>).map((r) => r.label).sort();
    expect(dbLabels.length).toBeGreaterThan(0);
    expect(dbLabels).toEqual([...DISCOVERED_ASSET_DETECTION_SOURCES].sort());
  });

  it('the device_role mirror reads the asset row and honours both manual axes', async () => {
    // discoveryWorker propagates the linked device's `device_role` with a
    // subquery that reads `discovered_assets.asset_type` back out, rather than
    // writing the type the scan proposed. Postgres is what makes that correct —
    // the mocked worker suite can only prove we built such a statement — so
    // drive the real statement shape here.
    const db = getTestDb() as any;
    const { org, site } = await seedOrg();

    const propagate = (assetId: string, deviceId: string) =>
      db.execute(sql`
        update devices
           set device_role = (select asset_type from discovered_assets where id = ${assetId}),
               device_role_source = 'discovery'
         where id = ${deviceId}
           and device_role_source is distinct from 'manual'
           and exists (
             select 1 from discovered_assets
              where id = ${assetId}
                and type_source <> 'manual'
                and asset_type <> 'unknown'
           )
      `);

    // devices.device_role is NOT NULL DEFAULT 'unknown' and device_role_source
    // NOT NULL DEFAULT 'auto', so an untouched device reads 'unknown'/'auto'.
    let deviceSeq = 0;
    const makeDevice = async (overrides: Record<string, unknown> = {}) => {
      deviceSeq += 1;
      const [row] = await db
        .insert(devices)
        .values({
          orgId: org.id,
          siteId: site.id,
          agentId: `agent-role-${deviceSeq}-${Date.now()}`,
          hostname: `role-host-${deviceSeq}`,
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          ...overrides,
        })
        .returning({ id: devices.id });
      return row;
    };
    const roleOf = async (id: string) => {
      const [row] = await db
        .select({ deviceRole: devices.deviceRole })
        .from(devices)
        .where(eq(devices.id, id));
      return row.deviceRole;
    };

    // 1. Happy path: the device takes the asset's SETTLED type.
    const okAsset = await seedAsset(org.id, site.id, {
      assetType: 'switch', typeSource: 'auto',
      detectedAssetType: 'switch', detectedTypeSource: 'unifi_controller',
    });
    const okDevice = await makeDevice();
    await propagate(okAsset.id, okDevice.id);
    expect(await roleOf(okDevice.id)).toBe('switch');

    // 2. A device whose role a user pinned is never touched.
    const pinnedDevice = await makeDevice({ deviceRole: 'server', deviceRoleSource: 'manual' });
    await propagate(okAsset.id, pinnedDevice.id);
    expect(await roleOf(pinnedDevice.id)).toBe('server');

    // 3. A manually-typed ASSET does not push its type onto the device either.
    const manualAsset = await seedAsset(org.id, site.id, {
      ipAddress: '10.88.1.10', macAddress: null,
      assetType: 'nas', typeSource: 'manual',
    });
    const untouched = await makeDevice();
    await propagate(manualAsset.id, untouched.id);
    expect(await roleOf(untouched.id)).toBe('unknown');

    // 4. An unclassified asset ('unknown') never overwrites a real role.
    const unknownAsset = await seedAsset(org.id, site.id, {
      ipAddress: '10.88.1.11', macAddress: null, assetType: 'unknown', typeSource: 'auto',
    });
    await propagate(unknownAsset.id, okDevice.id);
    expect(await roleOf(okDevice.id)).toBe('switch');
  });

  it('the guard survives concurrent writers because it is evaluated at write time', async () => {
    const db = getTestDb() as any;
    const { org, site } = await seedOrg();
    const asset = await seedAsset(org.id, site.id, {
      assetType: 'unknown',
      typeSource: 'auto',
    });

    // Both classifiers fire against a row neither has seen — the ordering the
    // JS pre-read in processResults cannot be trusted to observe. Whichever
    // lands second, the stronger source must own the row afterwards.
    await classify(asset.id, 'unifi_controller', 'switch');
    await classify(asset.id, 'vendor_oui', 'access_point');

    const row = await readAsset(asset.id);
    expect(row.assetType).toBe('switch');
    expect(row.detectedTypeSource).toBe('unifi_controller');

    // Sanity: the weak write really did execute against this row (it is not
    // passing because the statement silently matched zero rows).
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, org.id), eq(discoveredAssets.id, asset.id)));
    expect(count).toBe(1);
  });
});

describe('2026-08-20-discovered-asset-detection-source.sql backfill (#3187)', () => {
  /**
   * CI databases are migrated schema-fresh in globalSetup, so this migration's
   * backfill has only ever run against zero rows there — a green migration
   * says nothing about whether the UPDATE's WHERE clause is actually correct.
   * This replays the real, shipped `DO $$ ... END $$` block (extracted from
   * disk, not retyped) against seeded fixtures that predate the column.
   */

  async function seedUnifiChain() {
    const db = getTestDb() as any;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    const [integration] = await db
      .insert(unifiIntegrations)
      .values({ partnerId: partner.id, apiKeyEncrypted: 'test-backfill-key' })
      .returning({ id: unifiIntegrations.id });

    const [mapping] = await db
      .insert(unifiSiteMappings)
      .values({
        integrationId: integration.id,
        orgId: org.id,
        siteId: site.id,
        unifiHostId: 'host-backfill',
        unifiSiteId: 'usite-backfill',
      })
      .returning();

    return { org, site, integration, mapping };
  }

  async function linkUnifiDevice(
    assetId: string,
    ctx: { org: { id: string }; site: { id: string }; integration: { id: string }; mapping: { id: string } },
    unifiDeviceId: string,
  ) {
    const db = getTestDb() as any;
    await db.insert(unifiDevices).values({
      orgId: ctx.org.id,
      siteId: ctx.site.id,
      integrationId: ctx.integration.id,
      mappingId: ctx.mapping.id,
      discoveredAssetId: assetId,
      unifiDeviceId,
      raw: { id: unifiDeviceId },
    });
  }

  it('backfills only the linked-and-classified rows the migration comment promises', async () => {
    const backfillBlock = extractBackfillBlock(readFileSync(MIGRATION_FILE, 'utf8'));
    // Pin that we sliced the real UPDATE, not an empty or unrelated block.
    expect(backfillBlock).toContain("SET detected_type_source = 'unifi_controller'");
    expect(backfillBlock).toContain('unifi_devices');
    expect(backfillBlock).toContain('detected_type_source IS NULL');

    const ctx = await seedUnifiChain();

    // (a) linked + classified + NULL source → the migration's target case.
    const linkedClassified = await seedAsset(ctx.org.id, ctx.site.id, {
      ipAddress: '10.89.0.1',
      macAddress: 'aa:bb:cc:11:22:01',
      detectedAssetType: 'switch',
      detectedTypeSource: null,
    });
    await linkUnifiDevice(linkedClassified.id, ctx, 'ud-backfill-a');

    // (b) linked but never classified — no provenance to attribute, must stay NULL.
    const linkedUnclassified = await seedAsset(ctx.org.id, ctx.site.id, {
      ipAddress: '10.89.0.2',
      macAddress: 'aa:bb:cc:11:22:02',
      detectedAssetType: null,
      detectedTypeSource: null,
    });
    await linkUnifiDevice(linkedUnclassified.id, ctx, 'ud-backfill-b');

    // (c) classified but no unifi_devices link at all — must stay NULL.
    const unlinked = await seedAsset(ctx.org.id, ctx.site.id, {
      ipAddress: '10.89.0.3',
      macAddress: 'aa:bb:cc:11:22:03',
      detectedAssetType: 'router',
      detectedTypeSource: null,
    });

    // (d) already carries a detection source — the `IS NULL` guard must not overwrite it.
    const alreadyClassified = await seedAsset(ctx.org.id, ctx.site.id, {
      ipAddress: '10.89.0.4',
      macAddress: 'aa:bb:cc:11:22:04',
      detectedAssetType: 'access_point',
      detectedTypeSource: 'vendor_oui',
    });
    await linkUnifiDevice(alreadyClassified.id, ctx, 'ud-backfill-d');

    await getTestDb().execute(sql.raw(backfillBlock));

    expect((await readAsset(linkedClassified.id)).detectedTypeSource).toBe('unifi_controller');
    expect((await readAsset(linkedUnclassified.id)).detectedTypeSource).toBeNull();
    expect((await readAsset(unlinked.id)).detectedTypeSource).toBeNull();
    expect((await readAsset(alreadyClassified.id)).detectedTypeSource).toBe('vendor_oui');
  });
});
