/**
 * #9692 / #9644 — GET /discovery/profiles reports each profile's newest completed
 * scan. The original correlated subquery rendered `"profile_id" = "id"` in
 * Postgres, so it read NULL for every profile; route tests that mock `db` could
 * not see that. This is the real-Postgres guard the mocks cannot provide.
 */
import './setup';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { discoveryJobs, discoveryProfiles } from '../../db/schema';
import { discoveryRoutes } from '../../routes/discovery';
import { createIntegrationTestClient } from './db-utils';
import { getTestDb } from './setup';

const admin = () => getTestDb() as any;

const NEWEST_COMPLETED = new Date('2026-03-02T10:00:00.000Z');

describe('GET /discovery/profiles lastRunAt', () => {
  it('is the newest completed job per profile, and null for a profile that never completed one', async () => {
    const app = new Hono();
    app.route('/discovery', discoveryRoutes);
    const client = await createIntegrationTestClient(app);
    const { organization, site } = client.env;

    const [ran, neverRan] = await admin()
      .insert(discoveryProfiles)
      .values([
        { orgId: organization.id, siteId: site.id, name: 'ran', subnets: ['10.0.0.0/24'], methods: ['ping'] },
        { orgId: organization.id, siteId: site.id, name: 'never-ran', subnets: ['10.0.1.0/24'], methods: ['ping'] },
      ])
      .returning({ id: discoveryProfiles.id });

    const job = (profileId: string, status: string, completedAt: Date | null) => ({
      profileId, orgId: organization.id, siteId: site.id, status, completedAt,
    });
    await admin().insert(discoveryJobs).values([
      // Newest first, so insertion order cannot pass for completed_at order.
      job(ran.id, 'completed', NEWEST_COMPLETED),
      job(ran.id, 'completed', new Date('2026-03-01T10:00:00.000Z')),
      // Newer, but not completed: must not count as the last run.
      job(ran.id, 'failed', new Date('2026-03-03T10:00:00.000Z')),
      job(neverRan.id, 'failed', new Date('2026-03-03T10:00:00.000Z')),
    ]);

    const res = await client.get('/discovery/profiles');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; lastRunAt: string | null }> };
    const lastRunById = new Map(data.map((p) => [p.id, p.lastRunAt]));

    expect(lastRunById.get(ran.id)).toBe(NEWEST_COMPLETED.toISOString());
    expect(lastRunById.get(neverRan.id)).toBeNull();
  });
});
