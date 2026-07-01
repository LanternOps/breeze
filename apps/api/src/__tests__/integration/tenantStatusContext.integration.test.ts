/**
 * Real-DB regression test for #2108 (re-report of #2019): the tenant-status
 * reads in `services/tenantStatus.ts` must resolve under a genuine system
 * context even when the caller already holds a NARROWER ambient context.
 *
 * The manual-API-key MCP path establishes an org-scoped request context with an
 * EMPTY partner allowlist (`accessiblePartnerIds: []`, see middleware/apiKeyAuth.ts —
 * partner-axis RLS visibility is withheld from non-`mcp_provisioning` keys). Inside
 * that context, `routes/mcpServer.ts` calls `getActiveOrgTenant(orgId)` to resolve
 * the owning partnerId so a Partner Admin's role (which lives in partner_users) can
 * be threaded into `getUserPermissions`.
 *
 * `getActiveOrgTenant` → `getActivePartner` read the `partners` table. Pre-fix they
 * wrapped the read in `withSystemDbAccessContext`, which no-ops when a context is
 * already active — so the read ran under the org-scoped context, `breeze_has_partner_access`
 * returned false for the empty allowlist, the partner row was RLS-filtered to 0 rows,
 * and `getActiveOrgTenant` returned null → partnerId never resolved → every MCP
 * `tools/call` died "Insufficient permissions: no role assigned".
 *
 * The companion test in `permissionsContext.integration.test.ts` covers the
 * downstream `getUserPermissions` escalation, but it PASSES the partnerId in
 * directly — it never exercises the resolution proven here. If `readAsSystem`'s
 * `runOutsideDbContext` escalation is removed, the first test below fails (null).
 *
 * Runs against `breeze_app` (NOBYPASSRLS) so RLS is genuinely enforced — the whole
 * point of the test. Vacuous under a BYPASSRLS/superuser connection.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, hasDbAccessContext } from '../../db';
import { partners, organizations } from '../../db/schema';
import { getActiveOrgTenant, getActivePartner } from '../../services/tenantStatus';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface TenantFixture { partnerId: string; orgId: string }

/** Seed an ACTIVE partner and an ACTIVE org under it, committed under a system
 *  context so the rows exist independent of any request's RLS visibility. */
async function seedActiveTenant(status: 'active' | 'suspended' = 'active'): Promise<TenantFixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `TS ${sfx}`, slug: `ts-${sfx}`, type: 'msp', plan: 'pro', status })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: `TSOrg ${sfx}`, slug: `tso-${sfx}` })
      .returning({ id: organizations.id });
    return { partnerId: p!.id, orgId: o!.id };
  });
}

/** The manual org-scoped API-key request context: scope='organization', the key's
 *  single org accessible, and a deliberately EMPTY partner allowlist. */
function withManualOrgKeyContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      currentPartnerId: null,
    },
    fn,
  );
}

describe('tenantStatus reads escalate past a narrower ambient context (breeze_app, real DB, #2108)', () => {
  runDb('getActiveOrgTenant resolves the owning partnerId under an org-scoped context with empty partner allowlist', async () => {
    const f = await seedActiveTenant();

    const tenant = await withManualOrgKeyContext(f.orgId, () => {
      expect(hasDbAccessContext()).toBe(true); // prove the narrower context is active
      return getActiveOrgTenant(f.orgId);
    });

    // Pre-fix: null (partners row RLS-filtered to 0 under the empty partner allowlist).
    expect(tenant).not.toBeNull();
    expect(tenant?.orgId).toBe(f.orgId);
    expect(tenant?.partnerId).toBe(f.partnerId);
  });

  runDb('getActivePartner resolves an active partner under an org-scoped context with empty partner allowlist', async () => {
    const f = await seedActiveTenant();

    const partner = await withManualOrgKeyContext(f.orgId, () => getActivePartner(f.partnerId));

    expect(partner).not.toBeNull();
    expect(partner?.id).toBe(f.partnerId);
  });

  runDb('still resolves contextless (agent / pre-auth paths keep working)', async () => {
    const f = await seedActiveTenant();

    // No ambient context — the escalation must not regress the fresh-system-tx path.
    const tenant = await getActiveOrgTenant(f.orgId);

    expect(tenant?.partnerId).toBe(f.partnerId);
  });

  runDb('a SUSPENDED partner is still reported inactive (escalation reads truth, does not blanket-allow)', async () => {
    const f = await seedActiveTenant('suspended');

    // getActiveOrgTenant cascades through getActivePartner (strictly 'active'),
    // so a suspended partner => null even though the org row itself is active.
    const tenant = await withManualOrgKeyContext(f.orgId, () => getActiveOrgTenant(f.orgId));

    expect(tenant).toBeNull();
  });
});
