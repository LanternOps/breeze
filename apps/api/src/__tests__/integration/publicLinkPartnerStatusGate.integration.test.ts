/**
 * Real-Postgres coverage for the public-link tenant gate's partner axis.
 *
 * `resolveOrgLinkGate`/`resolveQuoteLinkOrgGate` (services/publicLinkOrgGate.ts)
 * back every unauthenticated public invoice-pay and quote-accept/pay route
 * (invoicesPublic.ts, quotesPublic.ts) — none of those routes carry a bearer
 * credential, so `middleware/partnerGuard.ts` structurally cannot reach them.
 * Partner suspension (`suspendPartnerForAbuse`, `revokePartnerTenantAccess`)
 * never writes `organizations.status`, so before this gate also checked the
 * owning partner, a partner suspended for abuse could still have its
 * customers pay already-issued invoices and accept/pay quotes through those
 * links. This runs the real join against Postgres — the mocked-chain unit
 * suite (publicLinkOrgGate.test.ts) proves the status-mapping logic, this
 * proves the actual SQL resolves the right partner for the right org/quote.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema/orgs';
import { quotes } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { resolveOrgLinkGate, resolveQuoteLinkOrgGate } from '../../services/publicLinkOrgGate';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedOrg() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partnerId: partner.id, orgId: org.id };
  });
}

async function seedSentQuote() {
  const fx = await seedOrg();
  const [q] = await withSystemDbAccessContext(() =>
    db
      .insert(quotes)
      .values({ partnerId: fx.partnerId, orgId: fx.orgId, currencyCode: 'USD', status: 'sent', quoteNumber: `Q-${Date.now()}` })
      .returning({ id: quotes.id }),
  );
  return { ...fx, quoteId: q!.id };
}

async function setPartnerStatus(partnerId: string, status: string) {
  await withSystemDbAccessContext(() =>
    db.update(partners).set({ status: status as 'active' | 'suspended' }).where(eq(partners.id, partnerId)),
  );
}

describe('public link gate — partner suspension (invoice pay / settle-return / quote accept-pay root cause)', () => {
  runDb('resolveOrgLinkGate (invoice pay + settle-return path) blocks a live org whose partner is suspended', async () => {
    const fx = await seedOrg();

    // Positive control: the org is live and unsuspended, the gate is open —
    // exactly the state a suspended-partner customer's already-issued pay
    // link would resolve to before this fix.
    expect((await resolveOrgLinkGate(fx.orgId)).blocked).toBe(false);

    await setPartnerStatus(fx.partnerId, 'suspended');
    const suspendedGate = await resolveOrgLinkGate(fx.orgId);
    expect(suspendedGate.blocked).toBe(true);
    expect(suspendedGate.partnerStatus).toBe('suspended');

    // Reactivation restores the link — suspension is a containment measure,
    // not a destructive one.
    await setPartnerStatus(fx.partnerId, 'active');
    expect((await resolveOrgLinkGate(fx.orgId)).blocked).toBe(false);
  });

  runDb('resolveQuoteLinkOrgGate (quote accept/pay path) blocks a live org whose partner is suspended', async () => {
    const fx = await seedSentQuote();

    expect((await resolveQuoteLinkOrgGate(fx.quoteId, [fx.orgId])).blocked).toBe(false);

    await setPartnerStatus(fx.partnerId, 'suspended');
    const suspendedGate = await resolveQuoteLinkOrgGate(fx.quoteId, [fx.orgId]);
    expect(suspendedGate.blocked).toBe(true);
    expect(suspendedGate.partnerStatus).toBe('suspended');

    await setPartnerStatus(fx.partnerId, 'active');
    expect((await resolveQuoteLinkOrgGate(fx.quoteId, [fx.orgId])).blocked).toBe(false);
  });

  runDb('an org directly suspended (not the partner) still blocks — the org axis is unchanged', async () => {
    const fx = await seedOrg();
    const { organizations } = await import('../../db/schema/orgs');
    await withSystemDbAccessContext(() =>
      db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, fx.orgId)),
    );
    expect((await resolveOrgLinkGate(fx.orgId)).blocked).toBe(true);
  });
});
