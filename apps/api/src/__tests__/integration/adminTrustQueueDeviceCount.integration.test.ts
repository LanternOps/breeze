/**
 * Admin trust-queue deviceCount subquery (#4603 pre-release sweep)
 *
 * `GET /admin/trust/queue`'s deviceCount correlated subquery interpolated
 * Drizzle Column objects (`${devices.orgId}`, `${organizations.id}`, ...)
 * directly into a raw `sql` template. Drizzle renders an interpolated Column
 * as a BARE, unqualified identifier ("id") rather than a table-qualified one
 * ("organizations"."id") — the same lesson already documented next to
 * routes/software.ts's versionCount subquery. With two joined tables each
 * having an `id` column, Postgres raised `column reference "id" is
 * ambiguous`, so this endpoint 500'd on every request, even with zero
 * partners in probation (the ambiguity is a parse/plan-time error, not a
 * row-count-dependent one).
 *
 * This test drives the real route handler against real Postgres — the
 * Drizzle-mock unit suite (routes/admin/trust.test.ts) mocks `db.select(...)`
 * entirely and so never executes real SQL text, which is why it could not
 * have caught this.
 *
 * Prerequisites: `pnpm test-stack up` (or docker compose -f
 * docker-compose.test.yml up -d) for a real Postgres instance.
 * Run: pnpm test:integration -- src/__tests__/integration/adminTrustQueueDeviceCount.integration.test.ts
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../../db';
import { devices, partners } from '../../db/schema';
import { trustAdminRoutes } from '../../routes/admin/trust';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/admin', trustAdminRoutes);
  return app;
}

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('GET /admin/trust/queue deviceCount subquery (#4603)', () => {
  it('returns 200 with an empty list when no partners are outside "trusted" (empty probation set)', async () => {
    // No fixtures at all — createPartner() defaults trustState to 'trusted'
    // (the schema default), so the queue's WHERE trust_state <> 'trusted'
    // naturally excludes it. Before the fix, this 500'd anyway: the ambiguous
    // column error is raised during query planning, independent of how many
    // rows partners/organizations/devices actually contain.
    await createPartner();

    const response = await buildApp().request('/admin/trust/queue');
    expect(response.status).toBe(200);

    const body = await response.json() as { partners: unknown[]; nextCursor: string | null };
    expect(body.partners).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('counts devices correctly (not zero, not every device in the DB) for a non-trusted partner', async () => {
    const partner = await createPartner();
    await withSystemDbAccessContext(() =>
      db.update(partners).set({ trustState: 'restricted' }).where(eq(partners.id, partner.id)),
    );
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    // A second, unrelated trusted partner/org/device proves the join is
    // correlated to the RIGHT partner and doesn't just count every device
    // in the database (which the ambiguous-column bug, if it silently
    // resolved to the wrong side instead of erroring, could have masked).
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    await getTestDb().insert(devices).values([
      {
        orgId: org.id,
        siteId: site.id,
        agentId: uniq('agent'),
        hostname: uniq('host'),
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
      },
      {
        orgId: org.id,
        siteId: site.id,
        agentId: uniq('agent'),
        hostname: uniq('host'),
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
      },
      {
        orgId: otherOrg.id,
        siteId: otherSite.id,
        agentId: uniq('agent'),
        hostname: uniq('host'),
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
      },
    ]);

    const response = await buildApp().request('/admin/trust/queue');
    expect(response.status).toBe(200);

    const body = await response.json() as { partners: Array<{ id: string; deviceCount: number }> };
    const row = body.partners.find((p) => p.id === partner.id);
    expect(row).toBeDefined();
    expect(row?.deviceCount).toBe(2);
    expect(body.partners.some((p) => p.id === otherPartner.id)).toBe(false);
  });
});
