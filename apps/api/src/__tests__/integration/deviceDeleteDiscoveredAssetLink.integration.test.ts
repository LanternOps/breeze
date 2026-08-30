/**
 * Real-Postgres coverage for the device hard-delete cascade against the
 * `discovered_assets` link constraint (#3952).
 *
 * THE DEFECT (reported from a self-hosted 0.107.0 deployment): permanently
 * deleting a decommissioned device returned 500 whenever discovery had
 * auto-linked an asset to it.
 *
 *   DELETE /api/v1/devices/:id/permanent -> 500
 *   UPDATE "discovered_assets" SET linked_device_id = NULL
 *     WHERE linked_device_id = $1
 *   PostgresError: new row for relation "discovered_assets" violates check
 *   constraint "discovered_assets_link_source_requires_link"
 *
 * `link_source` records HOW an asset came to be linked, and
 * 2026-06-27-discovered-asset-link-source.sql forbids the nonsensical
 * "source without a link":
 *
 *   CHECK (link_source IS NULL OR linked_device_id IS NOT NULL)
 *
 * The cascade nulled the pointer and left the source behind, so Postgres
 * raised 23514, the transaction rolled back, and the route — whose catch
 * special-cases only 23503 and 55P03 — rethrew into a bare 500.
 *
 * Why a real database is required: a CHECK constraint exists ONLY in SQL. The
 * Drizzle schema does not model it, so no amount of schema-derived contract
 * testing can see it, and the mocked suites (`deviceDeletion.test.ts`,
 * `cascadeDelete.test.ts`) resolve every statement regardless of what Postgres
 * would say. Those suites pin the generated SQL; only this one proves the
 * database accepts it.
 *
 * Coverage:
 *   1. The control — the OLD statement really is fatal against this database.
 *      Without it, tests 2 and 3 could pass on a schema where the constraint
 *      was never applied, i.e. prove nothing at all.
 *   2. The regression — an AUTO-linked asset no longer blocks the cascade, and
 *      the asset row SURVIVES the delete with its curated state intact.
 *   3. A MANUALLY linked asset detaches the same way. 'auto' is what the bug
 *      report carried, not the bug's boundary — the constraint draws no
 *      manual/auto distinction, and why no manual-link report arrived is not
 *      established. Covered so the fix is not silently scoped to the reported
 *      shape.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, discoveredAssets, sites } from '../../db/schema';
import {
  deleteDeviceCascade,
  type DeviceDeletionTx,
} from '../../services/deviceDeletion';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createSite } from './db-utils';

/** Postgres check_violation. */
const CHECK_VIOLATION = '23514';

const createdOrgs: string[] = [];

/** Everything here runs OUTSIDE a request, so escalate the way jobs do. */
function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

afterEach(async () => {
  if (createdOrgs.length === 0) return;
  await asSystem(async () => {
    for (const orgId of createdOrgs) {
      await db.delete(discoveredAssets).where(eq(discoveredAssets.orgId, orgId));
      await db.delete(devices).where(eq(devices.orgId, orgId));
      await db.delete(sites).where(eq(sites.orgId, orgId));
    }
  });
  createdOrgs.length = 0;
});

async function seedTenant(): Promise<{ orgId: string; siteId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  createdOrgs.push(org.id);
  const site = await createSite({ orgId: org.id });
  return { orgId: org.id, siteId: site.id };
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  return asSystem(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'decommissioned',
      })
      .returning({ id: devices.id });
    return row!.id;
  });
}

/**
 * A discovered asset linked to `deviceId`, carrying the operator-curated state
 * a detach must preserve.
 */
async function seedLinkedAsset(
  orgId: string,
  siteId: string,
  deviceId: string,
  linkSource: 'auto' | 'manual',
): Promise<string> {
  return asSystem(async () => {
    const [row] = await db
      .insert(discoveredAssets)
      .values({
        orgId,
        siteId,
        ipAddress: '192.0.2.37',
        macAddress: 'aa:bb:cc:dd:ee:ff',
        hostname: 'printer-3f',
        label: 'Reception printer',
        notes: 'Third floor, by the lifts',
        assetType: 'printer',
        approvalStatus: 'approved',
        linkedDeviceId: deviceId,
        linkSource,
      })
      .returning({ id: discoveredAssets.id });
    return row!.id;
  });
}

function readAsset(assetId: string) {
  return asSystem(async () => {
    const [row] = await db
      .select()
      .from(discoveredAssets)
      .where(eq(discoveredAssets.id, assetId));
    return row ?? null;
  });
}

function runCascade(deviceId: string): Promise<void> {
  return asSystem(() =>
    db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId);
    }),
  );
}

describe('device hard-delete vs discovered_assets link constraint (#3952)', () => {
  it('CONTROL: nulling linked_device_id alone is rejected by Postgres', async () => {
    // This is the statement the cascade used to issue. If this test ever goes
    // green-by-passing, the constraint is absent from the test database and
    // the two regression tests below are vacuous — they would pass on the
    // unfixed code too. Assert the SQLSTATE, not just "it threw": a connection
    // error would otherwise read as proof.
    const { orgId, siteId } = await seedTenant();
    const deviceId = await seedDevice(orgId, siteId);
    const assetId = await seedLinkedAsset(orgId, siteId, deviceId, 'auto');

    // Catch OUTSIDE asSystem, not around the statement. The access-context
    // helper runs its callback inside a transaction, so swallowing the error at
    // the inner boundary leaves that transaction aborted and the failure simply
    // resurfaces on the way out — the first revision of this test failed for
    // exactly that reason, with the right SQLSTATE in the wrong place.
    let err: unknown = null;
    try {
      await asSystem(() =>
        db.execute(
          sql`UPDATE discovered_assets SET linked_device_id = NULL WHERE id = ${assetId}`,
        ),
      );
    } catch (e: unknown) {
      err = e;
    }

    expect(err, 'the link_source CHECK constraint is missing from this database').not.toBeNull();
    // Drizzle wraps the postgres-js error, so the SQLSTATE lives on `.cause`.
    expect(pgErrorCode(err)).toBe(CHECK_VIOLATION);
  });

  it('deletes a device whose discovered asset was AUTO-linked, and keeps the asset', async () => {
    const { orgId, siteId } = await seedTenant();
    const deviceId = await seedDevice(orgId, siteId);
    const assetId = await seedLinkedAsset(orgId, siteId, deviceId, 'auto');

    // Before the fix this rejected with 23514 and rolled the whole cascade
    // back — the reported 500.
    await expect(runCascade(deviceId)).resolves.toBeUndefined();

    const device = await asSystem(async () => {
      const [row] = await db.select().from(devices).where(eq(devices.id, deviceId));
      return row ?? null;
    });
    expect(device, 'the device row must actually be gone').toBeNull();

    const asset = await readAsset(assetId);
    expect(asset, 'a detach must never delete the discovered asset').not.toBeNull();
    expect(asset!.linkedDeviceId).toBeNull();
    expect(asset!.linkSource).toBeNull();
    // Network inventory outlives the managed device: the asset describes an
    // endpoint that exists whether or not Breeze has an agent on it, and its
    // operator-curated state is the reason detaching beats deleting.
    expect(asset!.label).toBe('Reception printer');
    expect(asset!.notes).toBe('Third floor, by the lifts');
    expect(asset!.approvalStatus).toBe('approved');
    // Deleting a device says nothing about a human's "stop re-linking this"
    // preference (#3261), so the cascade must not set the suppression stamp.
    expect(asset!.autoLinkSuppressedAt).toBeNull();
  });

  it('deletes a device whose discovered asset was MANUALLY linked', async () => {
    const { orgId, siteId } = await seedTenant();
    const deviceId = await seedDevice(orgId, siteId);
    const assetId = await seedLinkedAsset(orgId, siteId, deviceId, 'manual');

    await expect(runCascade(deviceId)).resolves.toBeUndefined();

    const asset = await readAsset(assetId);
    expect(asset).not.toBeNull();
    expect(asset!.linkedDeviceId).toBeNull();
    expect(asset!.linkSource).toBeNull();
  });
});
