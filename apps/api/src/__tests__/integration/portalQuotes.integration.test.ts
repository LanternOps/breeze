import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances } from '../../db/schema/quotes';
import { invoices } from '../../db/schema/invoices';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';

// These exercise the SERVICE layer the portal routes call. The portal middleware
// (routes/portal/auth.ts) establishes an ORGANIZATION scope with NO partner access
// (accessiblePartnerIds: []) — the create/send side is the MSP's (system) and only
// accept/decline/pay run under the portal user's scope.
const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('portal quotes (org-scoped)', () => {
  runDb('portal accept records the portal user identity as signer + converts (system sub-context)', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: org.id };
    });
    const actor = { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] };
    // MSP side (create + send) runs in system scope, mirroring the dashboard.
    const created = await withSystemDbAccessContext(() => createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, actor));
    await withSystemDbAccessContext(() => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withSystemDbAccessContext(() => sendQuote(created.id, actor));

    // Regression guard (#1483 review): acceptQuote auto-issues the converted invoice,
    // which writes the partner-axis partner_invoice_sequences counter. The real portal
    // context has NO partner access, so a BARE call under that scope rolls back on an
    // RLS WITH CHECK violation — the handler MUST escape to a system sub-context.
    const portalCtx: DbAccessContext = { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [], userId: null };
    await expect(
      withDbAccessContext(portalCtx, () => acceptQuote({ quoteId: created.id, signerName: 'Bare' }))
    ).rejects.toThrow();
    const [stillSent] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(stillSent!.status).toBe('sent'); // the failed attempt rolled back — no orphan invoice/acceptance
    const orphans = await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, fx.orgId)));
    expect(orphans).toHaveLength(0);

    // The real portal handler wraps acceptQuote in runOutsideDbContext(withSystemDbAccessContext(...)).
    const res = await withSystemDbAccessContext(() => acceptQuote({ quoteId: created.id, signerName: 'Portal Pat', signerEmail: 'pat@org.example' }));
    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.signerName).toBe('Portal Pat');
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(q!.status).toBe('converted');
  });

  runDb('another org cannot read this org quote (RLS hides it under portal scope)', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const pA = await createPartner(); const oA = await createOrganization({ partnerId: pA.id });
      const pB = await createPartner(); const oB = await createOrganization({ partnerId: pB.id });
      const [qA] = await db.insert(quotes).values({ partnerId: pA.id, orgId: oA.id, currencyCode: 'USD', status: 'sent' }).returning({ id: quotes.id });
      return { orgB: oB.id, quoteA: qA!.id };
    });
    // Real portal scope: org-only, no partner access.
    const ctxB: DbAccessContext = { scope: 'organization', orgId: fx.orgB, accessibleOrgIds: [fx.orgB], accessiblePartnerIds: [], userId: null };
    const visible = await withDbAccessContext(ctxB, () => db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, fx.quoteA)));
    expect(visible).toHaveLength(0);
  });
});
