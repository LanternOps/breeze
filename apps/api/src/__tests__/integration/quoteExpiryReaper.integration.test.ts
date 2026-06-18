import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuote } from '../../services/quoteService';
import { expireQuotes } from '../../jobs/quoteExpiryReaper';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext { return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null }; }
function actorFor(orgId: string, partnerId: string): QuoteActor { return { userId: null, partnerId, accessibleOrgIds: [orgId] }; }
async function seed() { return withSystemDbAccessContext(async () => { const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id }); return { partner, org }; }); }

// Force a quote into an exact (status, expiry_date) combo, bypassing the lifecycle.
async function force(quoteId: string, status: string, expiryDate: string | null) {
  await withSystemDbAccessContext(() =>
    db.update(quotes).set({ status: status as any, expiryDate }).where(eq(quotes.id, quoteId)),
  );
}

describe('expireQuotes sweep', () => {
  runDb('flips only sent/viewed quotes past their expiry_date to expired', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const mk = () => withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));

    const sentPast = await mk();     await force(sentPast.id, 'sent', '2000-01-01');     // → expired
    const viewedPast = await mk();   await force(viewedPast.id, 'viewed', '2000-01-01'); // → expired
    const sentFuture = await mk();   await force(sentFuture.id, 'sent', '2999-01-01');   // stays sent
    const sentNoExpiry = await mk(); await force(sentNoExpiry.id, 'sent', null);          // stays sent (never expires)
    const draftPast = await mk();    await force(draftPast.id, 'draft', '2000-01-01');    // stays draft (not yet issued)
    const acceptedPast = await mk(); await force(acceptedPast.id, 'accepted', '2000-01-01'); // terminal-ish, untouched
    const convertedPast = await mk();await force(convertedPast.id, 'converted', '2000-01-01'); // untouched

    const count = await withSystemDbAccessContext(() => expireQuotes());
    expect(count).toBe(2);

    const all = await withSystemDbAccessContext(() =>
      db.select({ id: quotes.id, status: quotes.status }).from(quotes).where(inArray(quotes.id, [
        sentPast.id, viewedPast.id, sentFuture.id, sentNoExpiry.id, draftPast.id, acceptedPast.id, convertedPast.id,
      ])),
    );
    const byId = Object.fromEntries(all.map((q) => [q.id, q.status]));
    expect(byId[sentPast.id]).toBe('expired');
    expect(byId[viewedPast.id]).toBe('expired');
    expect(byId[sentFuture.id]).toBe('sent');
    expect(byId[sentNoExpiry.id]).toBe('sent');
    expect(byId[draftPast.id]).toBe('draft');
    expect(byId[acceptedPast.id]).toBe('accepted');
    expect(byId[convertedPast.id]).toBe('converted');
  });

  runDb('is a no-op (returns 0) when nothing is due', async () => {
    const { partner, org } = await seed();
    const ctx = ctxFor(org.id, partner.id); const actor = actorFor(org.id, partner.id);
    const q = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await force(q.id, 'sent', '2999-01-01');
    const count = await withSystemDbAccessContext(() => expireQuotes());
    expect(count).toBe(0);
  });
});
