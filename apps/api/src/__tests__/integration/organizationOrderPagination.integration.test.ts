/**
 * Cross-page organization ordering (#4004) — integration.
 *
 * `GET /orgs/organizations` used to select each page by `created_at, id` with
 * LIMIT/OFFSET and only then re-sort THAT PAGE by the partner's stored
 * `organizationOrder`. Page membership was therefore decided before the
 * preferred order was consulted, so an org the partner dragged to the top could
 * never leave page 2. `apps/web/src/lib/fetchAllOrganizations.ts` walks pages of
 * 100 and concatenates, which makes the assembled list correctly ordered inside
 * each block and wrong across every block boundary.
 *
 * These cases only discriminate because the fixture spans MORE THAN ONE PAGE
 * and the preferred order disagrees with `created_at` across that boundary. A
 * single-page assertion passes against the broken code.
 *
 * The compiled-SQL companion (`routes/orgs.listQuery.test.ts`) pins the
 * statement shape without a database; this file proves the shape actually
 * executes on real Postgres and returns the sequence claimed — including that
 * the `ARRAY[...]::uuid[]` parameter form is the one Postgres accepts (a
 * `${jsArray}::uuid[]` spread raises "cannot cast type record to uuid[]" at
 * runtime and no mock can see that).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/organizationOrderPagination.integration.test.ts
 */
import './setup';

import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { organizations, partners } from '../../db/schema';
import { orgRoutes } from '../../routes/orgs';
import { createIntegrationTestClient, createOrganization } from './db-utils';
import { getTestDb } from './setup';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/orgs', orgRoutes);
  return app;
}

interface ListResponse {
  data: Array<{ id: string; name: string }>;
  pagination: { page: number; limit: number; total: number };
}

/**
 * Stamp an explicit `created_at` per org so the "registration order" the
 * endpoint falls back to is deterministic. `created_at` is `defaultNow()` and
 * `now()` is the TRANSACTION timestamp, so fixture rows can otherwise tie —
 * which is exactly why `id` is a mandatory tiebreaker (#3462) and exactly what
 * would make an ordering assertion flaky rather than wrong.
 */
async function stampCreatedAt(orgIds: string[]): Promise<void> {
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  for (const [index, orgId] of orgIds.entries()) {
    await getTestDb()
      .update(organizations)
      .set({ createdAt: new Date(base + index * 60_000) })
      .where(eq(organizations.id, orgId));
  }
}

async function setPreferredOrder(partnerId: string, orderedIds: string[]): Promise<void> {
  // `organizationOrder` is plaintext inside the settings blob (the encrypted
  // column registry only wraps nested remote-access credentials), so seeding it
  // directly is faithful to what the PATCH /organizations/order route persists.
  await getTestDb()
    .update(partners)
    .set({
      settings: sql`COALESCE(${partners.settings}, '{}'::jsonb) || ${JSON.stringify({
        organizationOrder: orderedIds,
      })}::jsonb`,
    })
    .where(eq(partners.id, partnerId));
}

/** Walk every page the way `fetchAllOrganizations.ts` does and concatenate. */
async function walkPages(
  client: { get: (path: string) => Promise<Response> },
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  for (;;) {
    const res = await client.get(`/api/v1/orgs/organizations?page=${page}&limit=${limit}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    ids.push(...body.data.map((org) => org.id));
    if (body.data.length < limit || ids.length >= body.pagination.total) break;
    page += 1;
    if (page > 20) throw new Error('page walk did not terminate');
  }
  return ids;
}

/**
 * Five orgs under one partner, `created_at`-ascending, all reachable by the
 * returned partner-scoped client.
 */
async function seedFiveOrgs() {
  const app = buildApp();
  const client = await createIntegrationTestClient(app, { scope: 'partner' });
  const partnerId = client.env.partner.id;

  const extra = [];
  for (let i = 1; i < 5; i += 1) {
    extra.push(await createOrganization({ partnerId, name: `Ordering Customer ${i}` }));
  }
  const orgIds = [client.env.organization.id, ...extra.map((o) => o.id)];
  await stampCreatedAt(orgIds);
  return { client, partnerId, orgIds };
}

describe('GET /orgs/organizations — organizationOrder across page boundaries (#4004)', () => {
  it('returns the preferred order across pages, not merely within each page', async () => {
    const { client, partnerId, orgIds } = await seedFiveOrgs();
    // Exactly the reverse of created_at: every org has to cross a page
    // boundary for this to hold, so no page-local sort can satisfy it.
    const preferred = [...orgIds].reverse();
    await setPreferredOrder(partnerId, preferred);

    const firstPage = await client.get('/api/v1/orgs/organizations?page=1&limit=2');
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as ListResponse;
    expect(firstBody.pagination.total).toBe(5);
    // The pre-fix endpoint returned orgIds[0] and orgIds[1] here — the two
    // OLDEST orgs — because `created_at, id` chose the page before the stored
    // order was consulted.
    expect(firstBody.data.map((o) => o.id)).toEqual([preferred[0], preferred[1]]);

    const secondPage = await client.get('/api/v1/orgs/organizations?page=2&limit=2');
    const secondBody = (await secondPage.json()) as ListResponse;
    expect(secondBody.data.map((o) => o.id)).toEqual([preferred[2], preferred[3]]);

    const thirdPage = await client.get('/api/v1/orgs/organizations?page=3&limit=2');
    const thirdBody = (await thirdPage.json()) as ListResponse;
    expect(thirdBody.data.map((o) => o.id)).toEqual([preferred[4]]);
  });

  it('reassembles the exact stored order over a full page walk, with no repeat or drop', async () => {
    const { client, partnerId, orgIds } = await seedFiveOrgs();
    const preferred = [orgIds[3]!, orgIds[0]!, orgIds[4]!, orgIds[1]!, orgIds[2]!];
    await setPreferredOrder(partnerId, preferred);

    expect(await walkPages(client, 2)).toEqual(preferred);
    // The page size must not change the assembled sequence.
    expect(await walkPages(client, 50)).toEqual(preferred);
  });

  it('puts orgs missing from the stored order after the ordered ones, in created_at order', async () => {
    const { client, partnerId, orgIds } = await seedFiveOrgs();
    // Only the NEWEST org is pinned; the other four are unlisted. Pre-fix, the
    // pinned org sat on the last page and page 1 opened with the oldest orgs.
    await setPreferredOrder(partnerId, [orgIds[4]!]);

    expect(await walkPages(client, 2)).toEqual([
      orgIds[4],
      orgIds[0],
      orgIds[1],
      orgIds[2],
      orgIds[3],
    ]);
  });

  // NOT COVERED HERE — the system-scope branch (`else if (auth.scope === 'system'
  // && queryPartnerId)` in orgs.ts) cannot be reached over HTTP from this
  // harness, and the reason is worth recording rather than papering over. The
  // route is gated by `requireOrgRead` -> `requirePermission(ORGS_READ)`, and
  // `getUserPermissions` resolves a user's permissions through their
  // organization_users / partner_users membership keyed by the request's
  // partnerId/orgId. A system-scope token carries neither (db-utils mints
  // `partnerId: null` for system scope, by design), so the lookup returns null
  // and every system caller gets 403 "No permissions found" — before any
  // ordering code runs. Promoting the fixture user to `is_platform_admin`
  // clears the separate SR2-02 live-binding check (middleware/auth.ts:591) but
  // not this one: there is no platform-admin bypass in `getUserPermissions`.
  // Covering that branch needs a harness change (a system-reachable role), not
  // a change to this file, and the ordering it feeds is already proven by the
  // partner-scope cases above plus the compiled-SQL suite.

  it('falls back to created_at, id when the partner has stored no order', async () => {
    const { client, orgIds } = await seedFiveOrgs();
    expect(await walkPages(client, 2)).toEqual(orgIds);
  });

  it('ignores a stored id that is not UUID-shaped rather than failing the list', async () => {
    const { client, partnerId, orgIds } = await seedFiveOrgs();
    // A uuid[] cast over this array raises 22P02 and would 500 the whole list;
    // the pre-fix in-JS sort simply never matched such an entry.
    await setPreferredOrder(partnerId, ['not-a-uuid', orgIds[4]!]);

    const res = await client.get('/api/v1/orgs/organizations?page=1&limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.data.map((o) => o.id)).toEqual([orgIds[4], orgIds[0]]);
  });
});
