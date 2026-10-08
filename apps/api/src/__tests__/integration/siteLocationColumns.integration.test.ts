/**
 * #4186 W1 — site pin columns + time_entries.site_id (migration
 * 2026-12-17-140000-site-location-columns.sql) against a real Postgres.
 * Error-shape precedent: actionIntentsImmutabilityTrigger.integration.test.ts.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites } from '../../db/schema';

let siteId: string;

// The shared integration setup truncates between tests, so seed per test.
beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `SL ${sfx}`, slug: `sl-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'SLOrg', slug: `slo-${sfx}` })
      .returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `S-${sfx}` }).returning({ id: sites.id });
    siteId = s!.id;
  });
});

describe('site location columns migration', () => {
  it('adds the six sites columns with the spec types', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'sites' AND column_name IN
        ('latitude','longitude','geofence_radius_m','location_source','location_set_by','location_set_at')
      ORDER BY column_name`));
    expect([...rows]).toEqual([
      { column_name: 'geofence_radius_m', data_type: 'integer', numeric_precision: 32, numeric_scale: 0, is_nullable: 'YES' },
      { column_name: 'latitude', data_type: 'numeric', numeric_precision: 9, numeric_scale: 6, is_nullable: 'YES' },
      { column_name: 'location_set_at', data_type: 'timestamp with time zone', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
      { column_name: 'location_set_by', data_type: 'uuid', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
      { column_name: 'location_source', data_type: 'character varying', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
      { column_name: 'longitude', data_type: 'numeric', numeric_precision: 9, numeric_scale: 6, is_nullable: 'YES' },
    ]);
  });

  const bad: Array<[string, () => ReturnType<typeof sql>, string]> = [
    ['lat without lng', () => sql`UPDATE sites SET latitude = 1, longitude = NULL WHERE id = ${siteId}`, 'sites_location_pair_chk'],
    ['radius below 50', () => sql`UPDATE sites SET geofence_radius_m = 49 WHERE id = ${siteId}`, 'sites_geofence_radius_chk'],
    ['radius above 1000', () => sql`UPDATE sites SET geofence_radius_m = 1001 WHERE id = ${siteId}`, 'sites_geofence_radius_chk'],
    ['latitude 91', () => sql`UPDATE sites SET latitude = 91, longitude = 0 WHERE id = ${siteId}`, 'sites_location_range_chk'],
    ['longitude 181', () => sql`UPDATE sites SET latitude = 0, longitude = 181 WHERE id = ${siteId}`, 'sites_location_range_chk'],
    ['unknown source', () => sql`UPDATE sites SET location_source = 'gps' WHERE id = ${siteId}`, 'sites_location_source_chk'],
  ];
  it.each(bad)('rejects %s', async (_label, stmt, constraint) => {
    await expect(withSystemDbAccessContext(() => db.execute(stmt())))
      .rejects.toMatchObject({ cause: { code: '23514', constraint_name: constraint } });
  });

  it('accepts a full valid pin', async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE sites SET latitude = 40.712776, longitude = -74.005974, geofence_radius_m = 150,
        location_source = 'technician', location_set_at = now() WHERE id = ${siteId}`));
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT latitude::text AS lat FROM sites WHERE id = ${siteId}`));
    expect(rows[0]).toMatchObject({ lat: '40.712776' });
  });

  it('adds both FKs as ON DELETE SET NULL and validated', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname, confdeltype, convalidated FROM pg_constraint
      WHERE conname IN ('sites_location_set_by_fkey','time_entries_site_id_fkey') ORDER BY conname`));
    expect([...rows]).toEqual([
      { conname: 'sites_location_set_by_fkey', confdeltype: 'n', convalidated: true },
      { conname: 'time_entries_site_id_fkey', confdeltype: 'n', convalidated: true },
    ]);
  });
});
