import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteAcceptances } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { createQuoteAcceptToken, verifyQuoteAcceptToken } from '../../services/quoteAcceptToken';
import { acceptQuote } from '../../services/quoteAcceptService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('public quote token path', () => {
  runDb('an unauthenticated accept (system scope, token-resolved) records + converts', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      return { partnerId: partner.id, orgId: org.id };
    });
    const ctx: DbAccessContext = { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
    const actor = { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] };
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

    // Public path: mint+verify token, then accept under SYSTEM scope resolved from token claims.
    const { token } = await createQuoteAcceptToken({ quoteId: created.id, orgId: fx.orgId, partnerId: fx.partnerId });
    const claims = await verifyQuoteAcceptToken(token);
    expect(claims?.quoteId).toBe(created.id);
    const res = await withSystemDbAccessContext(() => acceptQuote({ quoteId: claims!.quoteId, signerName: 'Prospect Pat', acceptanceTokenJti: claims!.jti }));
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    expect(q!.status).toBe('converted');
    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.acceptanceTokenJti).toBe(claims!.jti);
  });

  runDb('the recorded hash matches a re-render and mismatches a tampered quote', async () => {
    const fx = await withSystemDbAccessContext(async () => { const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id }); return { partnerId: partner.id, orgId: org.id }; });
    const ctx: DbAccessContext = { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [fx.partnerId], userId: null };
    const actor = { userId: null, partnerId: fx.partnerId, accessibleOrgIds: [fx.orgId] };
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: fx.orgId, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, { sourceType: 'manual', description: 'Setup', quantity: 1, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time' } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    const res = await withSystemDbAccessContext(() => acceptQuote({ quoteId: created.id, signerName: 'Pat' }));
    const [acc] = await withSystemDbAccessContext(() => db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));

    // Re-render the SAME content → hash equals the recorded one. The hash was
    // captured inside acceptQuote while the quote was 'sent'; accept then
    // transitions it to 'converted'. Since computeQuoteSha256 is status-sensitive
    // (it's part of the canonical content), re-render with the at-accept status
    // ('sent') to reproduce the recorded hash — the quote body itself is immutable
    // once sent, so this isolates the tamper-evidence check to the line content.
    const { computeQuoteSha256 } = await import('../../services/quoteContentHash');
    const { quoteBlocks, quoteLines } = await import('../../db/schema/quotes');
    const [qRow] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, created.id)));
    const q = { ...qRow, status: 'sent' };
    const blocks = await withSystemDbAccessContext(() => db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, created.id)));
    const lines = await withSystemDbAccessContext(() => db.select().from(quoteLines).where(eq(quoteLines.quoteId, created.id)));
    expect(computeQuoteSha256(q as any, blocks as any, lines as any)).toBe(acc!.quoteSha256);
    const tampered = lines.map((l) => ({ ...l, unitPrice: '1.00', lineTotal: '1.00' }));
    expect(computeQuoteSha256(q as any, blocks as any, tampered as any)).not.toBe(acc!.quoteSha256);
  });
});
