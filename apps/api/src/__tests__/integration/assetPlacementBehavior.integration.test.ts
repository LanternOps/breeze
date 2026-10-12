/**
 * Placement-specific behaviour against real Postgres (spec §17, #8359).
 *
 * The generic RLS / cascade / merge / export contract suites cover
 * `asset_physical_placements` structurally. Nothing else proved the behaviour:
 * the DB-level invariants (one subject, never empty, ranges, same-org FK), the
 * save/upsert path, the link-time authority rule, the `device_wins` audit row,
 * and the lost-race path that used to surface as a bare 500.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { assetPhysicalPlacements, devices, discoveredAssets, sites } from '../../db/schema';
import {
  deletePlacement,
  PlacementConcurrentUpdateError,
  PlacementLinkConflictError,
  readPlacement,
  reconcilePlacementOnLink,
  reconcilePlacementOnLinkOrThrow,
  savePlacement,
  type PlacementExecutor,
  type PlacementSubject,
} from '../../services/assetPlacement';
import { pgErrorCode } from '../../utils/pgErrors';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const createdOrgs: string[] = [];

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

afterEach(async () => {
  if (createdOrgs.length === 0) return;
  const orgs = [...createdOrgs];
  createdOrgs.length = 0;
  await asSystem(async () => {
    await db.delete(assetPhysicalPlacements).where(inArray(assetPhysicalPlacements.orgId, orgs));
    await db.delete(discoveredAssets).where(inArray(discoveredAssets.orgId, orgs));
    await db.delete(devices).where(inArray(devices.orgId, orgs));
    await db.delete(sites).where(inArray(sites.orgId, orgs));
  });
});

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  createdOrgs.push(org.id);
  const site = await createSite({ orgId: org.id });
  return { orgId: org.id, siteId: site.id };
}

async function seedAsset(orgId: string, siteId: string, octet = 10): Promise<string> {
  return asSystem(async () => {
    const [row] = await db
      .insert(discoveredAssets)
      .values({ orgId, siteId, ipAddress: `192.0.2.${octet}`, assetType: 'switch' })
      .returning({ id: discoveredAssets.id });
    return row!.id;
  });
}

const deviceSubject = (t: { orgId: string; siteId: string }, id: string): PlacementSubject => ({
  kind: 'device', id, orgId: t.orgId, siteId: t.siteId,
});
const assetSubject = (t: { orgId: string; siteId: string }, id: string): PlacementSubject => ({
  kind: 'discovered', id, orgId: t.orgId, siteId: t.siteId,
});

const A = { room: 'MDF', rack: 'R1', rackUnit: 4, heightU: 2 };
const B = { room: 'IDF-2', rack: 'R9', rackUnit: 12, heightU: 1 };

async function rowCount(col: 'device_id' | 'discovered_asset_id', id: string): Promise<number> {
  const rows = await getTestDb().execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM asset_physical_placements WHERE ${sql.raw(col)} = ${id}`,
  );
  return rows[0]!.n;
}

describe('asset_physical_placements behaviour (#8359)', () => {
  runDb('save upserts in place, and an all-null save removes the row (never stored empty)', async () => {
    const t = await seedTenant();
    const { id: deviceId } = await createDevice(t);
    const subject = deviceSubject(t, deviceId);

    await asSystem(async () => {
      expect(await savePlacement(subject, A)).toEqual(A);
      expect(await savePlacement(subject, B)).toEqual(B);
      expect(await readPlacement('device', deviceId)).toEqual(B);
    });
    expect(await rowCount('device_id', deviceId)).toBe(1);

    await asSystem(async () => {
      expect(await savePlacement(subject, { room: null, rack: null, rackUnit: null, heightU: null })).toBeNull();
    });
    expect(await rowCount('device_id', deviceId)).toBe(0);
  });

  runDb('deletePlacement reports whether a row existed (no-op delete is false)', async () => {
    const t = await seedTenant();
    const { id: deviceId } = await createDevice(t);
    await asSystem(async () => {
      expect(await deletePlacement({ kind: 'device', id: deviceId })).toBe(false);
      await savePlacement(deviceSubject(t, deviceId), A);
      expect(await deletePlacement({ kind: 'device', id: deviceId })).toBe(true);
    });
  });

  runDb('the database rejects an empty placement, two subjects, no subject and out-of-range units', async () => {
    const t = await seedTenant();
    const { id: deviceId } = await createDevice(t);
    const assetId = await seedAsset(t.orgId, t.siteId);
    const insert = (cols: string, vals: unknown[]) =>
      getTestDb().execute(
        sql`INSERT INTO asset_physical_placements (org_id, ${sql.raw(cols)}) VALUES (${t.orgId}, ${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`,
      );

    const code = async (p: Promise<unknown>) => pgErrorCode(await p.then(() => null, (e) => e));
    expect(await code(insert('device_id', [deviceId]))).toBe('23514'); // not_empty
    expect(await code(insert('device_id, discovered_asset_id, room', [deviceId, assetId, 'x']))).toBe('23514'); // one_subject
    expect(await code(insert('room', ['x']))).toBe('23514'); // no subject
    expect(await code(insert('device_id, rack_unit', [deviceId, 101]))).toBe('23514');
    expect(await code(insert('device_id, height_u', [deviceId, 0]))).toBe('23514');
  });

  runDb('rejects a placement whose device belongs to a different org (composite FK)', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const { id: deviceInB } = await createDevice(b);
    const err = await getTestDb()
      .execute(sql`INSERT INTO asset_physical_placements (org_id, device_id, room) VALUES (${a.orgId}, ${deviceInB}, 'x')`)
      .then(() => null, (e) => e);
    expect(pgErrorCode(err)).toBe('23503');
  });

  runDb('a second row for the same device is rejected by the unique index', async () => {
    const t = await seedTenant();
    const { id: deviceId } = await createDevice(t);
    await asSystem(() => savePlacement(deviceSubject(t, deviceId), A));
    const err = await getTestDb()
      .execute(sql`INSERT INTO asset_physical_placements (org_id, device_id, room) VALUES (${t.orgId}, ${deviceId}, 'dup')`)
      .then(() => null, (e) => e);
    expect(pgErrorCode(err)).toBe('23505');
  });

  describe('link-time authority', () => {
    runDb('only the asset has a placement -> it moves to the device', async () => {
      const t = await seedTenant();
      const { id: deviceId } = await createDevice(t);
      const assetId = await seedAsset(t.orgId, t.siteId);
      await asSystem(async () => {
        await savePlacement(assetSubject(t, assetId), A);
        expect(await reconcilePlacementOnLink({ discoveredAssetId: assetId, deviceId, mode: 'manual' })).toBe('moved');
        expect(await readPlacement('device', deviceId)).toEqual(A);
        expect(await readPlacement('discovered', assetId)).toBeNull();
      });
    });

    runDb('identical placements on both -> the asset duplicate is dropped', async () => {
      const t = await seedTenant();
      const { id: deviceId } = await createDevice(t);
      const assetId = await seedAsset(t.orgId, t.siteId);
      await asSystem(async () => {
        await savePlacement(assetSubject(t, assetId), A);
        await savePlacement(deviceSubject(t, deviceId), A);
        expect(await reconcilePlacementOnLink({ discoveredAssetId: assetId, deviceId, mode: 'manual' })).toBe('deduplicated');
      });
      expect(await rowCount('discovered_asset_id', assetId)).toBe(0);
      expect(await rowCount('device_id', deviceId)).toBe(1);
    });

    runDb('manual link with differing placements -> conflict, nothing written', async () => {
      const t = await seedTenant();
      const { id: deviceId } = await createDevice(t);
      const assetId = await seedAsset(t.orgId, t.siteId);
      await asSystem(async () => {
        await savePlacement(assetSubject(t, assetId), A);
        await savePlacement(deviceSubject(t, deviceId), B);
        expect(await reconcilePlacementOnLink({ discoveredAssetId: assetId, deviceId, mode: 'manual' })).toBe('conflict');
        await expect(
          reconcilePlacementOnLinkOrThrow({ discoveredAssetId: assetId, deviceId, mode: 'manual' }),
        ).rejects.toBeInstanceOf(PlacementLinkConflictError);
        expect(await readPlacement('discovered', assetId)).toEqual(A);
        expect(await readPlacement('device', deviceId)).toEqual(B);
      });
    });

    runDb('automatic link with differing placements -> device wins and an audit row records what was discarded', async () => {
      const t = await seedTenant();
      const { id: deviceId } = await createDevice(t);
      const assetId = await seedAsset(t.orgId, t.siteId);
      await asSystem(async () => {
        await savePlacement(assetSubject(t, assetId), A);
        await savePlacement(deviceSubject(t, deviceId), B);
        expect(await reconcilePlacementOnLink({ discoveredAssetId: assetId, deviceId, mode: 'automatic' })).toBe('device_wins');
        expect(await readPlacement('device', deviceId)).toEqual(B);
      });
      expect(await rowCount('discovered_asset_id', assetId)).toBe(0);

      // The audit write is fire-and-forget on its own connection: poll briefly.
      let audit: Array<{ details: any; org_id: string; actor_type: string }> = [];
      for (let i = 0; i < 50 && audit.length === 0; i++) {
        audit = (await getTestDb().execute(
          sql`SELECT details, org_id, actor_type FROM audit_logs
               WHERE action = 'asset.placement.device_wins' AND resource_id = ${assetId}`,
        )) as any;
        if (audit.length === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(audit).toHaveLength(1);
      expect(audit[0]!.org_id).toBe(t.orgId);
      expect(audit[0]!.actor_type).toBe('system');
      expect(audit[0]!.details).toMatchObject({ deviceId, discarded: A, kept: B });
    });

    runDb('a lost unique-index race on the move surfaces as PlacementConcurrentUpdateError and rolls back', async () => {
      const t = await seedTenant();
      const { id: deviceId } = await createDevice(t);
      const assetId = await seedAsset(t.orgId, t.siteId);
      await asSystem(() => savePlacement(assetSubject(t, assetId), A));

      // Between reconcile reading the pair (no device placement yet) and its
      // UPDATE, a concurrent PUT commits a placement for the same device.
      let raced = false;
      await asSystem(async () => {
        await expect(
          db.transaction(async (tx) => {
            const ex = {
              select: tx.select.bind(tx),
              delete: tx.delete.bind(tx),
              update: (...args: Parameters<typeof tx.update>) => {
                const real = tx.update(...args);
                return {
                  set: (values: any) => {
                    const stmt = real.set(values);
                    return {
                      where: async (cond: any) => {
                        if (!raced) {
                          raced = true;
                          await getTestDb().execute(
                            sql`INSERT INTO asset_physical_placements (org_id, device_id, room) VALUES (${t.orgId}, ${deviceId}, 'raced')`,
                          );
                        }
                        return stmt.where(cond);
                      },
                    };
                  },
                };
              },
            } as unknown as PlacementExecutor;
            await reconcilePlacementOnLink({ discoveredAssetId: assetId, deviceId, mode: 'manual', executor: ex });
          }),
        ).rejects.toBeInstanceOf(PlacementConcurrentUpdateError);
      });

      expect(raced).toBe(true);
      // The asset keeps its placement; the racer's row is the device's.
      expect(await rowCount('discovered_asset_id', assetId)).toBe(1);
      expect(await rowCount('device_id', deviceId)).toBe(1);
    });
  });
});
