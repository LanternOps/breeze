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
import { db, withSystemDbAccessContext } from '../../db';
import {
  enrollmentKeys,
  installerBootstrapTokens,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { fetchInstallerTokenUsage } from '../../routes/enrollmentKeys';

const runDb = it.runIf(!!process.env.DATABASE_URL);

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

        // withoutTokens: a plain key (CLI / short-link flavour) that must come
        // back absent from the map so the UI falls back to its own counters.
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
        ]);

        return {
          partnerId: partner!.id,
          orgId: org!.id,
          siteId: site!.id,
          withTokensId: withTokens!.id,
          withoutTokensId: withoutTokens!.id,
        };
      });

      try {
        const usage = await withSystemDbAccessContext(() =>
          fetchInstallerTokenUsage([ids.withTokensId, ids.withoutTokensId]),
        );

        // One entry per PARENT KEY, not per token — this is the property the
        // avoided leftJoin exists to preserve. Two tokens on one key must not
        // become two rows.
        expect(usage.size).toBe(1);

        expect(usage.get(ids.withTokensId)).toEqual({ consumed: 4, max: 12 });
        // A key that never minted an installer is absent, so the route maps it
        // to null and the UI keeps showing usage_count / max_usage.
        expect(usage.get(ids.withoutTokensId)).toBeUndefined();

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
          await db.delete(sites).where(eq(sites.id, ids.siteId));
          await db.delete(organizations).where(eq(organizations.id, ids.orgId));
          await db.delete(partners).where(eq(partners.id, ids.partnerId));
        });
      }
    },
  );
});
