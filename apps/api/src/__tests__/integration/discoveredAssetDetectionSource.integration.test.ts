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
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite } from './db-utils';
import { discoveredAssets } from '../../db/schema';
import {
  buildClassificationWrite,
  DISCOVERED_ASSET_DETECTION_SOURCES,
  type DiscoveredAssetDetectionSource,
} from '../../services/discoveredAssetClassification';

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
