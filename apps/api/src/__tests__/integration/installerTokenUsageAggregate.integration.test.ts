/**
 * Real-Postgres coverage for the Enrollment Keys installer-capacity aggregate
 * (#2992).
 *
 * Why this file exists: every route suite replaces `db.select` wholesale with a
 * hand-shaped mock, so the SQL in `fetchInstallerTokenUsage` — which table it
 * reads, which column feeds `consumed` vs `max`, and whether the `IN` predicate
 * is applied at all — never executes. A review mutation test proved the gap:
 * swapping the two SUM sources, pointing `.from()` at the wrong table, and
 * replacing the predicate with an empty array ALL left the unit suite 43/43
 * green. The empty-predicate mutant is the worst of the three — it makes
 * `installerTokens` permanently null, i.e. silently reintroduces the exact bug
 * this work fixes, with a fully green suite.
 *
 * So: drive the real function against the real database, with deliberately
 * ASYMMETRIC values per token, so a swap or a wrong grouping cannot coincide.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  enrollmentKeys,
  installerBootstrapTokens,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { fetchInstallerTokenUsage } from '../../routes/enrollmentKeys';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: null,
    userId: null,
  };
}

describe('installer token usage aggregate (#2992, real Postgres)', () => {
  runDb(
    'sums device slots per parent key without fanning out or leaking across keys',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const ids = await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({
            name: `Agg Partner ${unique}`,
            slug: `agg-partner-${unique}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
          })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({
            currencyCode: 'USD',
            partnerId: partner!.id,
            name: `Agg Org ${unique}`,
            slug: `agg-org-${unique}`,
            type: 'customer',
            status: 'active',
          })
          .returning({ id: organizations.id });
        const [site] = await db
          .insert(sites)
          .values({ orgId: org!.id, name: `Agg Site ${unique}` })
          .returning({ id: sites.id });

        // withTokens: two downloads from one key — the 1:N shape that makes a
        // leftJoin onto the list query unsafe.
        const [withTokens] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: org!.id,
            siteId: site!.id,
            name: 'installer parent',
            key: `agg-parent-key-${unique}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            maxUsage: 1,
          })
          .returning({ id: enrollmentKeys.id });

        // withoutTokens: a plain key (CLI flavour) that must come back absent
        // from the map so the UI falls back to its own counters. Since #3034
        // the routes hand EVERY key on the page to this function — there is no
        // per-key pre-filter any more — so `mixedKind` below covers the case
        // that pre-filter used to handle, per token and against real SQL.
        const [withoutTokens] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: org!.id,
            siteId: site!.id,
            name: 'plain key',
            key: `agg-plain-key-${unique}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            maxUsage: 10,
          })
          .returning({ id: enrollmentKeys.id });

        // mixedKind (#3034): a short-link CHILD that carries BOTH kinds of
        // token — the per-download ones every public click mints, and one real
        // capacity token from an authenticated build off that child row. The
        // pre-#3034 code discriminated on the parent's `short_code` and so had
        // to suppress the whole key; the aggregate must instead sum the capacity
        // token ALONE. This is the fixture the mocked unit suites cannot
        // provide: only real Postgres evaluates the `usage_kind` predicate.
        const [mixedKind] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: org!.id,
            siteId: site!.id,
            name: 'installer parent (link x7)',
            key: `agg-mixed-key-${unique}`,
            shortCode: `aggmix${unique.slice(-4)}`.slice(0, 12),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            maxUsage: 7,
          })
          .returning({ id: enrollmentKeys.id });

        // Asymmetric on purpose: consumed (3 + 1 = 4) and max (7 + 5 = 12) are
        // distinct from each other AND from the token count, so swapping the
        // two SUM sources — or grouping by the wrong column — cannot produce
        // the expected answer by coincidence.
        await db.insert(installerBootstrapTokens).values([
          {
            token: `agg-token-a-${unique}`,
            orgId: org!.id,
            parentEnrollmentKeyId: withTokens!.id,
            siteId: site!.id,
            usageKind: "capacity",
            maxUsage: 7,
            consumedCount: 3,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            installerPlatform: 'windows',
          },
          {
            token: `agg-token-b-${unique}`,
            orgId: org!.id,
            parentEnrollmentKeyId: withTokens!.id,
            siteId: site!.id,
            usageKind: "capacity",
            maxUsage: 5,
            consumedCount: 1,
            // Deliberately already expired: the aggregation rule includes
            // expired tokens so the figure stays stable instead of silently
            // shrinking when an installer ages out. created_at must be pushed
            // back too — installer_bootstrap_tokens_expires_after_created is a
            // real CHECK, so a past expiry with a defaulted now() creation is
            // rejected at insert.
            createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
            expiresAt: new Date(Date.now() - 60 * 60 * 1000),
            installerPlatform: 'macos',
          },
          // Two public downloads off the short link. maxUsage 1 each, exactly as
          // serveInstaller hardcodes. Summing these would report "2 slots",
          // which is a click count wearing a capacity's clothes.
          {
            token: `agg-token-dl1-${unique}`,
            orgId: org!.id,
            parentEnrollmentKeyId: mixedKind!.id,
            siteId: site!.id,
            usageKind: 'per_download',
            maxUsage: 1,
            consumedCount: 1,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            installerPlatform: 'windows',
          },
          {
            token: `agg-token-dl2-${unique}`,
            orgId: org!.id,
            parentEnrollmentKeyId: mixedKind!.id,
            siteId: site!.id,
            usageKind: 'per_download',
            maxUsage: 1,
            consumedCount: 0,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            installerPlatform: 'windows',
          },
          // A pre-#3034 row whose mint path the backfill could not prove. Also
          // excluded: unknown provenance must degrade to showing nothing, never
          // to a number that might be a click count.
          {
            token: `agg-token-legacy-${unique}`,
            orgId: org!.id,
            parentEnrollmentKeyId: mixedKind!.id,
            siteId: site!.id,
            usageKind: 'legacy_unknown',
            maxUsage: 1,
            consumedCount: 1,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            installerPlatform: 'windows',
          },
          // The authenticated build off the child row — 6 device slots, 2 taken.
          // The ONLY token of the three that is a device-slot budget.
          {
            token: `agg-token-cap-${unique}`,
            orgId: org!.id,
            parentEnrollmentKeyId: mixedKind!.id,
            siteId: site!.id,
            usageKind: 'capacity',
            maxUsage: 6,
            consumedCount: 2,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            installerPlatform: 'windows',
          },
        ]);

        return {
          partnerId: partner!.id,
          orgId: org!.id,
          siteId: site!.id,
          withTokensId: withTokens!.id,
          withoutTokensId: withoutTokens!.id,
          mixedKindId: mixedKind!.id,
        };
      });

      try {
        const usage = await withSystemDbAccessContext(() =>
          fetchInstallerTokenUsage([
            ids.withTokensId,
            ids.withoutTokensId,
            ids.mixedKindId,
          ]),
        );

        // One entry per PARENT KEY, not per token — this is the property the
        // avoided leftJoin exists to preserve. Two tokens on one key must not
        // become two rows. Two entries: withTokens and mixedKind.
        expect(usage.size).toBe(2);

        // Totals span both tokens; the live pair (#3039) is FILTERed to the
        // unexpired one (token A: 3 / 7). The expired token B (1 / 5) must be
        // in the totals — the figure stays stable as installers age out — but
        // OUT of the live cut, or a dead installer reads as free capacity.
        // Same asymmetry rationale: no swap of the four sources can coincide.
        expect(usage.get(ids.withTokensId)).toEqual({
          consumed: 4,
          max: 12,
          liveConsumed: 3,
          liveMax: 7,
        });
        // A key that never minted an installer is absent, so the route maps it
        // to null and the UI keeps showing usage_count / max_usage.
        expect(usage.get(ids.withoutTokensId)).toBeUndefined();

        // #3034 — the whole point. mixedKind carries four tokens: two
        // per_download (1 slot each), one legacy_unknown (1 slot), and one
        // capacity (6 slots, 2 consumed). Only the capacity token counts, so the
        // answer is exactly that token and nothing else.
        //
        // Every wrong implementation lands on a DIFFERENT number here, which is
        // what makes this assertion worth a real DB: summing everything gives
        // 9 max / 4 consumed; dropping only per_download gives 7 / 3; the old
        // per-key short_code gate gives `undefined`.
        expect(usage.get(ids.mixedKindId)).toEqual({
          consumed: 2,
          max: 6,
          liveConsumed: 2,
          liveMax: 6,
        });

        // The predicate really filters: asking for only the plain key must not
        // drag in the other key's tokens.
        const narrowed = await withSystemDbAccessContext(() =>
          fetchInstallerTokenUsage([ids.withoutTokensId]),
        );
        expect(narrowed.size).toBe(0);

        // Numbers are coerced, not left as Postgres' string SUM output.
        const consumed = usage.get(ids.withTokensId)!.consumed;
        expect(typeof consumed).toBe('number');
      } finally {
        // enrollment_keys -> installer_bootstrap_tokens is ON DELETE CASCADE,
        // so removing the keys takes the token rows with them.
        await withSystemDbAccessContext(async () => {
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, ids.withTokensId));
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, ids.withoutTokensId));
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, ids.mixedKindId));
          await db.delete(sites).where(eq(sites.id, ids.siteId));
          await db.delete(organizations).where(eq(organizations.id, ids.orgId));
          await db.delete(partners).where(eq(partners.id, ids.partnerId));
        });
      }
    },
  );

  /**
   * The helper claims it "never throws" and degrades to no-installer-info
   * rather than 500-ing the Enrollment Keys page. That claim is only true
   * because the query runs on a nested SAVEPOINT.
   *
   * A bare try/catch does NOT achieve it: request handlers run inside
   * withDbAccessContext's postgres.js `sql.begin`, which records the error on
   * the outer scope and re-throws it at COMMIT even though the callback
   * resolved (#2189). Swallowing would still 500, just without the route's own
   * context. This test pins the difference — it fails if the savepoint is
   * removed, even with the try/catch left in place.
   */
  runDb('degrades to an empty map without poisoning the request transaction', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const org = await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `Degrade Partner ${unique}`,
          slug: `degrade-partner-${unique}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      const [o] = await db
        .insert(organizations)
        .values({
          currencyCode: 'USD',
          partnerId: partner!.id,
          name: `Degrade Org ${unique}`,
          slug: `degrade-org-${unique}`,
          type: 'customer',
          status: 'active',
        })
        .returning({ id: organizations.id });
      return { partnerId: partner!.id, orgId: o!.id };
    });

    try {
      // The whole point: this must RESOLVE. Before the savepoint it rejected
      // at commit with the raw PostgresError.
      const outcome = await withDbAccessContext(orgCtx(org.orgId), async () => {
        // 'not-a-uuid' makes Postgres throw 22P02 inside the aggregate —
        // a real failure shape, not a stubbed one.
        const usage = await fetchInstallerTokenUsage(['not-a-uuid']);

        // The outer transaction must still be usable afterwards; a poisoned
        // one fails every follow-up query with 25P02.
        const [stillAlive] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, org.orgId));

        return { size: usage.size, stillAlive: stillAlive?.id };
      });

      expect(outcome.size).toBe(0);
      expect(outcome.stillAlive).toBe(org.orgId);
    } finally {
      await withSystemDbAccessContext(async () => {
        await db.delete(organizations).where(eq(organizations.id, org.orgId));
        await db.delete(partners).where(eq(partners.id, org.partnerId));
      });
    }
  });
});
