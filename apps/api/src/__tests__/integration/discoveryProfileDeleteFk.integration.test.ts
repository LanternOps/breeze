/**
 * Real-Postgres coverage for deleting a discovery profile once discovery has
 * produced anything that points back at it (#7036).
 *
 * THE DEFECT: `DELETE /discovery/profiles/:id` deletes the profile's
 * `discovery_jobs` and then the profile in one transaction. Three foreign keys
 * into those rows were declared with no ON DELETE action (NO ACTION):
 *
 *   discovered_assets.last_job_id        -> discovery_jobs(id)
 *   network_baselines.last_scan_job_id   -> discovery_jobs(id)
 *   network_change_events.profile_id     -> discovery_profiles(id)
 *
 * so any profile that had ever discovered an asset failed with 23503, the
 * transaction rolled back, and the route answered 500.
 *
 * All three columns are nullable "last seen by" / provenance pointers; the rows
 * that carry them are the customer's inventory and history and must survive the
 * profile's deletion. 2026-11-01-100000-discovery-job-fk-set-null.sql flips the
 * three constraints to ON DELETE SET NULL.
 *
 * Why a real database is required: FK actions live in SQL. The mocked route
 * suite (`routes/discovery.test.ts`) resolves every statement regardless of
 * what Postgres would say.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  discoveredAssets,
  discoveryJobs,
  discoveryProfiles,
  networkBaselines,
  networkChangeEvents,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

/** Everything here runs OUTSIDE a request, so escalate the way jobs do. */
function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function seedProfileWithHistory() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  return asSystem(async () => {
    const [profile] = await db.insert(discoveryProfiles).values({
      orgId: org.id,
      siteId: site.id,
      name: 'stale test profile',
      subnets: ['192.0.2.0/24'],
      methods: ['ping'],
    }).returning();
    const [job] = await db.insert(discoveryJobs).values({
      profileId: profile!.id,
      orgId: org.id,
      siteId: site.id,
      status: 'completed',
    }).returning();
    const [asset] = await db.insert(discoveredAssets).values({
      orgId: org.id,
      siteId: site.id,
      ipAddress: '192.0.2.1',
      hostname: 'router',
      lastJobId: job!.id,
    }).returning();
    const [baseline] = await db.insert(networkBaselines).values({
      orgId: org.id,
      siteId: site.id,
      subnet: '192.0.2.0/24',
      lastScanJobId: job!.id,
    }).returning();
    const [event] = await db.insert(networkChangeEvents).values({
      orgId: org.id,
      siteId: site.id,
      baselineId: baseline!.id,
      profileId: profile!.id,
      eventType: 'new_device',
      ipAddress: '192.0.2.1',
    }).returning();
    return { profile: profile!, job: job!, asset: asset!, baseline: baseline!, event: event! };
  });
}

/** The exact statement sequence `DELETE /discovery/profiles/:id` runs. */
async function deleteProfileLikeTheRoute(profileId: string) {
  await asSystem(() => db.transaction(async (tx) => {
    await tx.delete(discoveryJobs).where(eq(discoveryJobs.profileId, profileId));
    await tx.delete(discoveryProfiles).where(eq(discoveryProfiles.id, profileId));
  }));
}

describe('discovery profile delete vs. rows that point at it (#7036)', () => {
  it('every FK into discovery_jobs / discovery_profiles from a history table is ON DELETE SET NULL', async () => {
    const rows = await asSystem(() => db.execute(sql`
      SELECT c.conrelid::regclass::text AS tbl,
             a.attname AS col,
             c.confdeltype AS action
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f'
         AND c.confrelid IN ('public.discovery_jobs'::regclass, 'public.discovery_profiles'::regclass)
         AND c.conrelid::regclass::text IN ('discovered_assets', 'network_baselines', 'network_change_events')
       ORDER BY 1, 2
    `)) as unknown as Array<{ tbl: string; col: string; action: string }>;

    expect(rows.map((r) => `${r.tbl}.${r.col}:${r.action}`)).toEqual([
      'discovered_assets.last_job_id:n',
      'network_baselines.last_scan_job_id:n',
      'network_change_events.profile_id:n',
    ]);
  });

  it('deletes the profile and its jobs, keeping discovered assets, baselines and change events with the pointers nulled', async () => {
    const seeded = await seedProfileWithHistory();

    await expect(deleteProfileLikeTheRoute(seeded.profile.id)).resolves.toBeUndefined();

    await asSystem(async () => {
      expect(await db.select().from(discoveryProfiles)
        .where(eq(discoveryProfiles.id, seeded.profile.id))).toHaveLength(0);
      expect(await db.select().from(discoveryJobs)
        .where(eq(discoveryJobs.id, seeded.job.id))).toHaveLength(0);

      const [asset] = await db.select().from(discoveredAssets)
        .where(eq(discoveredAssets.id, seeded.asset.id));
      expect(asset).toBeDefined();
      expect(asset!.lastJobId).toBeNull();
      expect(asset!.hostname).toBe('router');

      const [baseline] = await db.select().from(networkBaselines)
        .where(eq(networkBaselines.id, seeded.baseline.id));
      expect(baseline).toBeDefined();
      expect(baseline!.lastScanJobId).toBeNull();

      const [event] = await db.select().from(networkChangeEvents)
        .where(eq(networkChangeEvents.id, seeded.event.id));
      expect(event).toBeDefined();
      expect(event!.profileId).toBeNull();
    });
  });
});
