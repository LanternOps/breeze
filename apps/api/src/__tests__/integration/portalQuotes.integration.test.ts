import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';

// These exercise the SERVICE layer the portal routes call, under the SAME org
// scope the portal middleware establishes. (Full HTTP route tests would need
// the portal session harness; the service-under-portal-scope path is the
// security-critical surface.)
const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('portal quotes (org-scoped)', () => {
  runDb('portal accept records the portal user identity as signer + converts', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: org.id };
    });
    const ctx: DbAccessContext = { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
    const actor = { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] };
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    // Portal handler would call acceptQuote with the portal_user's name/email.
    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: created.id, signerName: 'Portal Pat', signerEmail: 'pat@org.example' }));
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
      return { orgB: oB.id, partnerB: pB.id, quoteA: qA!.id };
    });
    const ctxB: DbAccessContext = { scope: 'organization', orgId: fx.orgB, accessibleOrgIds: [fx.orgB], accessiblePartnerIds: [fx.partnerB], userId: null };
    const visible = await withDbAccessContext(ctxB, () => db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, fx.quoteA)));
    expect(visible).toHaveLength(0);
  });
});
