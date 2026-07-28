/**
 * Real-Postgres integration coverage for issueBootstrapTokenForKey's
 * independent TTL (#2775).
 *
 * `installerBootstrapTokenIssuance.ts` is `vi.mock`ed in every route suite
 * (installer.test.ts, enrollmentKeys.test.ts, etc.), so the actual INSERT —
 * and in particular the `expiresAt` column it persists — has never executed
 * against a real database. That gap is exactly how #2775 shipped: the parent
 * enrollment key created by the Add Device modal is a deliberately transient
 * 60-minute container, and pre-fix code clamped the child bootstrap token's
 * expiry to the parent's remaining life, so every installer died in ~60
 * minutes no matter what TTL the admin picked.
 *
 * This test drives the real service function against the test Postgres and
 * asserts against the row read back from the database — not the service's
 * return value, which is a local variable and would pass even if the INSERT
 * itself wrote the wrong value.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { enrollmentKeys, installerBootstrapTokens, organizations, partners, sites } from '../../db/schema';
import { issueBootstrapTokenForKey } from '../../services/installerBootstrapTokenIssuance';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('installer bootstrap token TTL (#2775, real Postgres)', () => {
  runDb(
    'a 30-day token issued from a 60-minute parent key persists an expires_at ~30 days out, read back from the DB',
    async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const ids = await withSystemDbAccessContext(async () => {
        const [partner] = await db
          .insert(partners)
          .values({
            name: `TTL Partner ${unique}`,
            slug: `ttl-partner-${unique}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
          })
          .returning({ id: partners.id });
        const [org] = await db
          .insert(organizations)
          .values({
            partnerId: partner!.id,
            name: `TTL Org ${unique}`,
            slug: `ttl-org-${unique}`,
            type: 'customer',
            status: 'active',
          })
          .returning({ id: organizations.id });
        const [site] = await db
          .insert(sites)
          .values({ orgId: org!.id, name: `TTL Site ${unique}` })
          .returning({ id: sites.id });

        // The Add Device modal's deliberately transient parent: expires in
        // 60 minutes (PR #739 review finding #1).
        const [parent] = await db
          .insert(enrollmentKeys)
          .values({
            orgId: org!.id,
            siteId: site!.id,
            name: 'transient parent',
            key: `ttl-parent-key-${unique}`,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
            maxUsage: 1,
          })
          .returning({ id: enrollmentKeys.id });

        const issued = await issueBootstrapTokenForKey({
          parentEnrollmentKeyId: parent!.id,
          createdByUserId: null,
          maxUsage: 25,
          ttlMinutes: 43200, // 30 days — admin's chosen expiry
        });

        return {
          partnerId: partner!.id,
          orgId: org!.id,
          siteId: site!.id,
          parentId: parent!.id,
          issuedId: issued.id,
        };
      });

      try {
        const row = await withSystemDbAccessContext(async () => {
          const [r] = await db
            .select()
            .from(installerBootstrapTokens)
            .where(eq(installerBootstrapTokens.id, ids.issuedId));
          return r;
        });

        expect(row).toBeDefined();
        const ttlMs = new Date(row!.expiresAt).getTime() - Date.now();
        // 30 days = 2,592,000,000ms. Bounding both sides proves the column
        // reflects the full 30-day admin-chosen TTL — not the parent's
        // 60-minute lifetime (the pre-fix clamp bug) and not the 24h
        // issuance default (bootstrapTokenExpiresAt()).
        expect(ttlMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
        expect(ttlMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);
      } finally {
        // Clean up every row created above. enrollment_keys ->
        // installer_bootstrap_tokens is ON DELETE CASCADE, so deleting the
        // parent key also removes the bootstrap token row.
        await withSystemDbAccessContext(async () => {
          await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, ids.parentId));
          await db.delete(sites).where(eq(sites.id, ids.siteId));
          await db.delete(organizations).where(eq(organizations.id, ids.orgId));
          await db.delete(partners).where(eq(partners.id, ids.partnerId));
        });
      }
    },
  );
});
