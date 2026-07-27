/**
 * Real-Postgres integration coverage for the partner-axis RLS gap in
 * getEnrollmentDefaultsForOrg (fix round 1, #2776 task 3.4).
 *
 * The bug: `getEnrollmentDefaultsForOrg` reads `partners.settings` via a
 * `leftJoin`. `partners`' SELECT policy is `breeze_has_partner_access(id)`
 * (apps/api/migrations/2026-04-11-partners-rls.sql), which evaluates against
 * `breeze.accessible_partner_ids` — and `computeAccessiblePartnerIds` returns
 * `[]` for `scope === 'organization'` (apps/api/src/middleware/auth.ts). Every
 * route that calls this resolver (via assertTtlWithinCap) is
 * `requireScope("organization", "partner", "system")`, so an org-scoped
 * caller — exactly the population the cap exists to bind — would silently
 * get `partnerSettings = null` from the join, `maxTtlMinutes` falling back to
 * the permissive global default, and the partner's configured cap never
 * enforced at all.
 *
 * A mocked-DB unit test cannot catch this: the mock always returns whatever
 * row the test stages, with no RLS evaluation. Only a real Postgres
 * connection running through the actual `breeze_app` role, under a real
 * `withDbAccessContext` org-scoped RLS session, can prove the join is
 * visible. This test reproduces the exact ambient context an org-scoped
 * HTTP request runs under (authMiddleware wraps every request in
 * `withDbAccessContext` keyed off the caller's auth — see
 * apps/api/src/middleware/auth.ts:606) and asserts the resolver still
 * surfaces the partner's cap from inside it.
 */
import './setup';

import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { getEnrollmentDefaultsForOrg } from '../../services/enrollmentDefaults';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Mirrors authMiddleware's computeAccessiblePartnerIds for scope 'organization': []. */
function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const createdOrgIds: string[] = [];
const createdPartnerIds: string[] = [];

afterEach(async () => {
  if (createdOrgIds.length === 0 && createdPartnerIds.length === 0) return;
  await withSystemDbAccessContext(async () => {
    for (const id of createdOrgIds) {
      await db.delete(organizations).where(eq(organizations.id, id));
    }
    for (const id of createdPartnerIds) {
      await db.delete(partners).where(eq(partners.id, id));
    }
  });
  createdOrgIds.length = 0;
  createdPartnerIds.length = 0;
});

describe('getEnrollmentDefaultsForOrg — partner-cap visibility under org-scoped RLS (fix round 1, #2776)', () => {
  runDb(
    "an org-scoped caller (accessiblePartnerIds: []) still resolves the partner's configured TTL cap",
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const ids = await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({
            name: `Cap Partner ${unique}`,
            slug: `cap-partner-${unique}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
            settings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } },
          })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({
            partnerId: partner!.id,
            name: `Cap Org ${unique}`,
            slug: `cap-org-${unique}`,
            type: 'customer',
            status: 'active',
          })
          .returning({ id: organizations.id });
        return { partnerId: partner!.id, orgId: org!.id };
      });
      createdPartnerIds.push(ids.partnerId);
      createdOrgIds.push(ids.orgId);

      // The crux of the reproduction: call the resolver from INSIDE the same
      // kind of RLS context an org-scoped HTTP request runs under, not from
      // withSystemDbAccessContext. Pre-fix, getEnrollmentDefaultsForOrg ran
      // its query directly against whatever context was already ambient —
      // here, the org-scoped one — so the partners leftJoin would silently
      // return null and maxTtlMinutes would be the permissive global
      // default (525_600) instead of the partner's configured 1440.
      const resolved = await withDbAccessContext(orgContext(ids.orgId), () =>
        getEnrollmentDefaultsForOrg(ids.orgId),
      );

      expect(resolved.maxTtlMinutes).toBe(1440);
    },
  );

  runDb(
    'sanity check: the raw partners row IS actually invisible to this org-scoped context (proves the RLS premise, not just the fix)',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const ids = await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({
            name: `Sanity Partner ${unique}`,
            slug: `sanity-partner-${unique}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
          })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({
            partnerId: partner!.id,
            name: `Sanity Org ${unique}`,
            slug: `sanity-org-${unique}`,
            type: 'customer',
            status: 'active',
          })
          .returning({ id: organizations.id });
        return { partnerId: partner!.id, orgId: org!.id };
      });
      createdPartnerIds.push(ids.partnerId);
      createdOrgIds.push(ids.orgId);

      const rows = await withDbAccessContext(orgContext(ids.orgId), () =>
        db.select({ id: partners.id }).from(partners).where(eq(partners.id, ids.partnerId)),
      );

      // If this ever starts returning the row, the whole premise of this
      // bug (and the fix) is gone — the partners RLS policy itself changed
      // and this test file needs re-evaluating, not just green-lit.
      expect(rows).toHaveLength(0);
    },
  );
});

/**
 * Fix round 4 (#2776) — AVAILABILITY. The round-1 escape
 * (`runOutsideDbContext(withSystemDbAccessContext(...))`) is correct for an
 * org-scoped caller but catastrophic for a caller that is ALREADY system-scoped:
 * `withDbAccessContext` opens a real `baseDb.transaction`, so the outer context
 * pins one pooled connection for its whole callback, and `runOutsideDbContext`
 * exits the AsyncLocalStorage store so the inner system context does NOT nest —
 * it borrows a SECOND connection while the first is still held. Every device
 * enrollment (POST /installer/bootstrap) and every public installer download
 * traverses such a path. At N concurrent requests >= DB_POOL_MAX, every
 * connection is held by a request queued for a connection only a peer can
 * release; postgres-js has no acquire timeout (`connect_timeout` is TCP connect,
 * not queue wait), so the API stalls indefinitely rather than merely slowing.
 *
 * The test below asserts the MECHANISM, not the value — the two code paths
 * return the identical number, so only transaction visibility can tell them
 * apart. It writes the partner+org inside an OPEN system transaction and then
 * calls the resolver from inside that same transaction. Uncommitted rows are
 * invisible to any other connection, so:
 *   - reads in the AMBIENT transaction  -> sees the row  -> cap 1440
 *   - opens a SECOND connection instead -> sees nothing  -> product default 525600
 * i.e. it fails, loudly and specifically, the moment the second connection
 * comes back.
 */
describe('getEnrollmentDefaultsForOrg — no second pooled connection for a system-scoped caller (fix round 4, #2776)', () => {
  runDb(
    'reads inside the caller’s own system transaction (uncommitted rows are visible), rather than on a second connection',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const { resolved, ids } = await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({
            name: `Ambient Partner ${unique}`,
            slug: `ambient-partner-${unique}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
            settings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } },
          })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({
            partnerId: partner!.id,
            name: `Ambient Org ${unique}`,
            slug: `ambient-org-${unique}`,
            type: 'customer',
            status: 'active',
          })
          .returning({ id: organizations.id });

        // Still INSIDE the transaction that wrote these rows, and still
        // uncommitted: only a read on this very connection can see them.
        const resolved = await getEnrollmentDefaultsForOrg(org!.id);
        return { resolved, ids: { partnerId: partner!.id, orgId: org!.id } };
      });

      createdPartnerIds.push(ids.partnerId);
      createdOrgIds.push(ids.orgId);

      expect(resolved.maxTtlMinutes).toBe(1440);
    },
  );
});
