/**
 * Real-Postgres proof for `resolveOrgTaxRate`'s tenancy contract
 * (settings consolidation W02-API, M12).
 *
 * WHY THIS MUST BE AN INTEGRATION TEST. The resolver's fail-closed rule — the
 * `organizations` row is read in the caller's AMBIENT RLS context, and a row
 * that does not come back means "reject", never "fall through to the partner
 * default" — is a statement about what Postgres' RLS policies do. A mocked-DB
 * unit test stages whatever row it likes with no policy evaluation at all, so
 * it can only assert the shape of the code, never that the row is genuinely
 * invisible. Only a real `breeze_app` connection inside a genuine
 * `withDbAccessContext` session can prove it.
 *
 * The consequence of a regression here is a tax-computation bug, not a
 * cosmetic one: falling through would apply the PARTNER's default rate to an
 * org the caller cannot see — potentially a tax-exempt customer.
 */
import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../../db';
import { organizations, partners } from '../../db/schema/orgs';
import { resolveOrgTaxRate, OrgNotVisibleForTaxError } from '../../services/taxRateResolver';
import { buildDbAccessContext } from '../../middleware/auth';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Built with the PRODUCTION builder, exactly as
// partnerAxisSystemContext.integration.test.ts's own orgContext() does — see
// that file's comment on why a hand-rolled literal would silently drift from
// what authMiddleware actually produces.
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return buildDbAccessContext({
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    partnerId,
    userId: null,
  });
}

function partnerContext(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return buildDbAccessContext({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    partnerId,
    userId: null,
  });
}

describe('resolveOrgTaxRate — partner-axis tenancy contract (integration)', () => {
  let partnerAId: string;
  let partnerBId: string;
  let orgAId: string;
  let orgBId: string;

  // Seeded per test, NOT in beforeAll: `setup.ts`'s global beforeEach
  // TRUNCATEs partners/organizations before every test, so a beforeAll fixture
  // would be gone by the first assertion.
  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // ONE TRANSACTION PER PARTNER. `breeze_partner_export_organizations_insert`
    // enforces a lock hierarchy (all partner locks before any organization
    // lock); seeding both partners and both orgs in a single transaction
    // requests partner B's lock after org A's and aborts with P0001.
    await withSystemDbAccessContext(async () => {
      const [partnerA] = await db.insert(partners).values({
        name: `Tax Partner A ${unique}`, slug: `tax-partner-a-${unique}`,
        type: 'msp', plan: 'pro', status: 'active', defaultTaxRate: '0.06500',
      }).returning({ id: partners.id });
      partnerAId = partnerA!.id;

      const [orgA] = await db.insert(organizations).values({
        currencyCode: 'USD', partnerId: partnerAId, name: `Tax Org A ${unique}`,
        slug: `tax-org-a-${unique}`, type: 'customer', status: 'active',
        taxExempt: false, taxRate: null, settings: {},
      }).returning({ id: organizations.id });
      orgAId = orgA!.id;
    });

    await withSystemDbAccessContext(async () => {
      const [partnerB] = await db.insert(partners).values({
        name: `Tax Partner B ${unique}`, slug: `tax-partner-b-${unique}`,
        type: 'msp', plan: 'pro', status: 'active', defaultTaxRate: '0.01000',
      }).returning({ id: partners.id });
      partnerBId = partnerB!.id;

      // Org B: under partner B, TAX-EXEMPT with a distinctive stored rate — if
      // the fail-closed contract ever regressed to fail-OPEN, an org-A-scoped
      // read of orgB would silently return partner A's default instead of
      // rejecting, which is exactly the bug this file exists to catch.
      const [orgB] = await db.insert(organizations).values({
        currencyCode: 'USD', partnerId: partnerBId, name: `Tax Org B ${unique}`,
        slug: `tax-org-b-${unique}`, type: 'customer', status: 'active',
        taxExempt: true, taxRate: '0.09900', settings: {},
      }).returning({ id: organizations.id });
      orgBId = orgB!.id;
    });
  });

  runDb('an org-scoped token for org A gets partner A\'s default rate', async () => {
    const rate = await runOutsideDbContext(() => withDbAccessContext(
      orgContext(orgAId, partnerAId),
      () => resolveOrgTaxRate({ orgId: orgAId, partnerId: partnerAId })
    ));
    expect(rate).toBe('0.06500');
  });

  runDb('an org-A-scoped context reading org B (a real, cross-tenant row) is DENIED by RLS, not silently defaulted', async () => {
    // Discriminating test: under the OLD implementation (org read under
    // withSystemDbAccessContext, bypassing RLS) this would have returned org
    // B's row, seen taxExempt: true, and returned null — a WRONG but
    // superficially plausible answer no shape-only assertion would catch. The
    // NEW contract must reject outright, because org B is genuinely invisible
    // to an org-A-scoped context.
    await expect(
      runOutsideDbContext(() => withDbAccessContext(
        orgContext(orgAId, partnerAId),
        () => resolveOrgTaxRate({ orgId: orgBId, partnerId: partnerAId })
      ))
    ).rejects.toThrow(OrgNotVisibleForTaxError);

    // CONTROL: org B is a REAL row, not a nonexistent id — read under system
    // scope (which bypasses RLS) to prove the rejection above came from RLS
    // denying visibility, not from the row being absent.
    const [controlRow] = await withSystemDbAccessContext(() =>
      db.select({ id: organizations.id, taxExempt: organizations.taxExempt })
        .from(organizations).where(eq(organizations.id, orgBId)).limit(1)
    );
    expect(controlRow?.id).toBe(orgBId);
    expect(controlRow?.taxExempt).toBe(true);
  });

  runDb('a partner-B-scoped context reading org A (belongs to a different partner) is DENIED by RLS', async () => {
    await expect(
      runOutsideDbContext(() => withDbAccessContext(
        partnerContext(partnerBId, [orgBId]),
        () => resolveOrgTaxRate({ orgId: orgAId, partnerId: partnerBId })
      ))
    ).rejects.toThrow(OrgNotVisibleForTaxError);
  });
});
