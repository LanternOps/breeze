/**
 * BRZ-8807 PR 3a: does partners.billing_enabled=false survive an
 * organization-scope DB context? `partners` SELECT RLS is partner-axis only.
 * Runs on the production `db` (breeze_app, subject to RLS). setup.ts TRUNCATEs
 * before every test: seed per test.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { isBillingEnabledForOrg, isBillingEnabledForPartner } from '../../services/billingEnabled';
import { assertInvoiceBillingEnabled } from '../../services/invoiceBillingGate';

async function seed(billingEnabled: boolean) {
  return withSystemDbAccessContext(async () => {
    const sfx = randomUUID();
    const [p] = await db.insert(partners).values({ name: 'P', slug: `p-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'O', slug: `o-${sfx}` }).returning({ id: organizations.id });
    await db.update(partners).set({ billingEnabled }).where(eq(partners.id, p!.id));
    return { partnerId: p!.id, orgId: o!.id };
  });
}

const orgCtx = (orgId: string): DbAccessContext => ({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [] });
const partnerCtx = (partnerId: string, orgId: string): DbAccessContext => ({ scope: 'partner', orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], currentPartnerId: partnerId });

describe('billing_enabled visibility per access-context scope (real DB, breeze_app)', () => {
  it('role under test is the RLS-subject breeze_app, not a superuser', async () => {
    const r = (await withSystemDbAccessContext(() => db.execute(sql`select current_user as u, (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypass`))) as unknown as Array<{ u: string; bypass: boolean }>;
    console.log('ROLE', JSON.stringify(r[0]));
    expect(r[0]!.u).toBe('breeze_app');
    expect(r[0]!.bypass).toBe(false);
  });

  for (const enabled of [false, true]) {
    const expected = enabled;
    describe(`partner billing_enabled=${enabled}`, () => {
      it('system scope', async () => {
        const s = await seed(enabled);
        const [a, b] = await withSystemDbAccessContext(async () => [await isBillingEnabledForPartner(s.partnerId), await isBillingEnabledForOrg(s.orgId)]);
        console.log(`OBSERVED system enabled=${enabled}: partner=${a} org=${b}`);
        expect(a).toBe(expected);
        expect(b).toBe(expected);
      });
      it('partner scope', async () => {
        const s = await seed(enabled);
        const [a, b] = await withDbAccessContext(partnerCtx(s.partnerId, s.orgId), async () => [await isBillingEnabledForPartner(s.partnerId), await isBillingEnabledForOrg(s.orgId)]);
        console.log(`OBSERVED partner enabled=${enabled}: partner=${a} org=${b}`);
        expect(a).toBe(expected);
        expect(b).toBe(expected);
      });
      it('organization scope', async () => {
        const s = await seed(enabled);
        const [a, b] = await withDbAccessContext(orgCtx(s.orgId), async () => [await isBillingEnabledForPartner(s.partnerId), await isBillingEnabledForOrg(s.orgId)]);
        console.log(`OBSERVED organization enabled=${enabled}: partner=${a} org=${b}`);
        expect(a).toBe(expected);
        expect(b).toBe(expected);
      });
    });
  }

  it('measure: assertInvoiceBillingEnabled under org scope with billing off throws BILLING_DISABLED', async () => {
    const s = await seed(false);
    let code: unknown = 'NO_THROW';
    await withDbAccessContext(orgCtx(s.orgId), async () => {
      try { await assertInvoiceBillingEnabled(s.orgId); } catch (e) { code = (e as { code?: unknown }).code; }
    });
    console.log(`OBSERVED assertInvoiceBillingEnabled org scope: ${String(code)}`);
    expect(code).toBe('BILLING_DISABLED');
  });
});
