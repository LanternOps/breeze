/**
 * Real-driver cross-tenant forge tests for the SentinelOne partner-axis tables.
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually enforced.
 * If `.env.test` is missing the symlink that pins this to the breeze_app role,
 * these tests would pass vacuously on a BYPASSRLS admin connection (see memory:
 * worktree_env_test_rls_vacuous) — the forged-insert assertions are the guard
 * that catches that. The rls-coverage contract test does NOT catch a missing
 * 2nd axis or a WITH CHECK hole on partner-axis tables; only a functional
 * breeze_app insert (this file) does.
 *
 * Tables under test:
 *   - s1_integrations  (partner-axis, RLS shape 3)
 *   - s1_org_mappings  (partner-axis, RLS shape 3, with FK-integrity EXISTS
 *                       clause on INSERT/UPDATE to prevent cross-partner
 *                       integration references)
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS):
 *   partnerA → orgA → s1IntegrationA → s1OrgMappingA
 *   partnerB → orgB
 *
 * Why NO memoization: setup.ts runs cleanupDatabase() in a beforeEach that
 * TRUNCATE ... CASCADEs partners/organizations before every test, wiping every
 * seeded row. A module-level cache would hand later cases rows that no longer
 * exist, making the assertions vacuous. Each it() re-seeds fresh — matching
 * every sibling *-rls.integration.test.ts.
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
import { s1Integrations, s1OrgMappings } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

// Re-seeds fresh on every call. Intentionally NOT memoized (see file header).
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const [integrationA] = await db
      .insert(s1Integrations)
      .values({
        partnerId: partnerA.id,
        name: 'S1 Test Integration',
        apiTokenEncrypted: 'enc:test-token',
        managementUrl: 'https://usea1.sentinelone.net',
        isActive: true,
      })
      .returning();
    if (!integrationA) throw new Error('failed to seed s1 integration');

    const [mappingA] = await db
      .insert(s1OrgMappings)
      .values({
        integrationId: integrationA.id,
        partnerId: partnerA.id,
        s1SiteId: 's1-site-001',
        s1SiteName: 'Customer A Site',
        orgId: orgA.id,
      })
      .returning();
    if (!mappingA) throw new Error('failed to seed s1 org mapping');

    return { partnerA, orgA, partnerB, orgB, integrationA, mappingA };
  });
}

describe('SentinelOne partner-axis RLS (breeze_app)', () => {
  runDb('partner B cannot SELECT partner A s1_integrations row (0 rows)', async () => {
    const { partnerB, integrationA } = await seed();

    const rows = await withDbAccessContext(partnerCtx(partnerB.id), () =>
      db.select().from(s1Integrations).where(eq(s1Integrations.id, integrationA.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('system scope CAN read partner A integration (existence probe — proves case above is genuine isolation)', async () => {
    const { integrationA } = await seed();

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(s1Integrations).where(eq(s1Integrations.id, integrationA.id))
    );
    expect(rows).toHaveLength(1);
  });

  runDb('partner B cannot INSERT an s1_integrations row with partner_id = P1 (42501)', async () => {
    const { partnerA, partnerB } = await seed();

    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(s1Integrations).values({
          partnerId: partnerA.id, // forged — partner B context, partner A owner
          name: 'forged-integration',
          apiTokenEncrypted: 'enc:forged',
          managementUrl: 'https://usea1.sentinelone.net',
          isActive: false,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('org-scope context cannot SELECT partner A s1_integrations credentials (0 rows)', async () => {
    const { orgA, integrationA } = await seed();

    const rows = await withDbAccessContext(orgCtx(orgA.id), () =>
      db.select().from(s1Integrations).where(eq(s1Integrations.id, integrationA.id))
    );
    // org-scope context has no partner reach; partner-axis RLS returns 0 rows silently
    expect(rows).toHaveLength(0);
  });

  runDb('partner B cannot INSERT into s1_org_mappings referencing partner A integration (FK-integrity EXISTS + partner policy = 42501)', async () => {
    const { partnerA, partnerB, integrationA } = await seed();

    // Insert s1_org_mappings with:
    //   integration_id = partner A's integration (FK resolves at DB level)
    //   partner_id = partner A (forged — partner B context)
    // The s1_org_mappings INSERT policy requires BOTH:
    //   1. breeze_has_partner_access(partner_id) — fails for partnerB trying to claim partnerA
    //   2. EXISTS(SELECT 1 FROM s1_integrations WHERE id = integration_id AND partner_id = s1_org_mappings.partner_id)
    // Either condition suffices to produce the 42501 rejection.
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(s1OrgMappings).values({
          integrationId: integrationA.id,
          partnerId: partnerA.id, // forged — only RLS WITH CHECK can reject this
          s1SiteId: 'forged-site-999',
          s1SiteName: 'Forge Site',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('partner A CAN: SELECT its own integration (1 row), INSERT its own s1_org_mappings, and map an org under P1', async () => {
    const { partnerA, orgA, integrationA } = await seed();

    // SELECT own integration
    const rows = await withDbAccessContext(partnerCtx(partnerA.id), () =>
      db.select().from(s1Integrations).where(eq(s1Integrations.id, integrationA.id))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.partnerId).toBe(partnerA.id);

    // INSERT own s1_org_mappings with org_id mapped to P1's org
    const [newMapping] = await withDbAccessContext(partnerCtx(partnerA.id), () =>
      db
        .insert(s1OrgMappings)
        .values({
          integrationId: integrationA.id,
          partnerId: partnerA.id,
          s1SiteId: 's1-site-002',
          s1SiteName: 'P1 Second Site',
          orgId: orgA.id, // org under P1
        })
        .returning()
    );
    expect(newMapping).toBeDefined();
    expect(newMapping?.partnerId).toBe(partnerA.id);
    expect(newMapping?.orgId).toBe(orgA.id);
  });
});
