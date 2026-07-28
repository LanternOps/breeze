/**
 * HTTP-level tests for the UNAUTHENTICATED public quote router
 * (routes/quotesPublic.ts). The sibling quotesPublic.integration.test.ts drives
 * the service layer; this file drives the real Hono routes via app.request so it
 * covers the glue the service tests can't: the token resolve() gate, the
 * draft-hide + customer-visible line FILTER on the public GET, the inline public
 * decline guard, and single-use token revocation (a link can't be replayed after
 * accept/decline). Every handler runs its DB work under
 * runOutsideDbContext(withSystemDbAccessContext(...)) — exercised for real here,
 * not stubbed.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { quotes, quoteLines } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { createQuoteAcceptToken } from '../../services/quoteAcceptToken';
import { getRedis } from '../../services/redis';
import { quotesPublicRoutes } from '../../routes/quotesPublic';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes); // mirrors index.ts mount
  return a;
}

/** Seed a quote (+optional lines) under system scope and mint its accept token. */
async function seedQuote(opts: { status?: 'draft' | 'sent'; lines?: { description: string; unitPrice: string; recurrence?: string; customerVisible?: boolean }[] } = {}) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [q] = await db.insert(quotes).values({
      partnerId: partner.id, orgId: org.id, currencyCode: 'USD',
      status: opts.status ?? 'sent', quoteNumber: opts.status === 'draft' ? null : 'Q-2026-0001',
    }).returning({ id: quotes.id });
    for (let i = 0; i < (opts.lines?.length ?? 0); i++) {
      const l = opts.lines![i]!;
      await db.insert(quoteLines).values({
        quoteId: q!.id, orgId: org.id, sourceType: 'manual', description: l.description,
        quantity: '1', unitPrice: l.unitPrice, lineTotal: l.unitPrice,
        recurrence: (l.recurrence ?? 'one_time') as any, taxable: false,
        customerVisible: l.customerVisible ?? true, sortOrder: i,
      });
    }
    const { token } = await createQuoteAcceptToken({ quoteId: q!.id, orgId: org.id, partnerId: partner.id });
    return { quoteId: q!.id, orgId: org.id, token };
  });
}

const postJson = (path: string, body: unknown) =>
  app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('public quote routes (HTTP, unauthenticated token)', () => {
  runDb('GET hides non-customer-visible lines and stamps sent→viewed', async () => {
    const { quoteId, token } = await seedQuote({ lines: [
      { description: 'Public line', unitPrice: '100.00', customerVisible: true },
      { description: 'Internal cost note', unitPrice: '40.00', customerVisible: false },
    ] });
    const res = await app().request(`/quotes/public/${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { quote: { status: string }; lines: { description: string }[] } };
    expect(body.data.quote.status).toBe('viewed');
    const descriptions = body.data.lines.map((l) => l.description);
    expect(descriptions).toContain('Public line');
    expect(descriptions).not.toContain('Internal cost note'); // the customerVisible filter
    // DB: first_viewed_at stamped + status flipped.
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('viewed');
    expect(q!.firstViewedAt).toBeTruthy();
  });

  runDb('GET returns the exact customer quote header keyset', async () => {
    const { token } = await seedQuote();
    const res = await app().request(`/quotes/public/${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { quote: Record<string, unknown> } };

    expect(Object.keys(body.data.quote)).toEqual([
      'id',
      'quoteNumber',
      'title',
      'status',
      'currencyCode',
      'issueDate',
      'expiryDate',
      'subtotal',
      'taxRate',
      'taxTotal',
      'total',
      'oneTimeTotal',
      'monthlyRecurringTotal',
      'annualRecurringTotal',
      'depositType',
      'depositAmount',
      'dueOnAcceptanceTotal',
      'depositDueTotal',
      'categoryBreakdown',
      'billToName',
      'introNotes',
      'terms',
      'sellerSnapshot',
      'coverPage',
      'termsAndConditions',
    ]);
  });

  runDb('GET on a draft quote returns 404 (a draft is never visible via token)', async () => {
    const { token } = await seedQuote({ status: 'draft' });
    const res = await app().request(`/quotes/public/${token}`);
    expect(res.status).toBe(404);
  });

  runDb('GET with a garbage token returns 401', async () => {
    const res = await app().request('/quotes/public/not-a-real-token-string');
    expect(res.status).toBe(401);
  });

  runDb('POST decline flips to declined + persists the reason, then 409 on re-decline', async () => {
    const { quoteId, token } = await seedQuote();
    const res = await postJson(`/quotes/public/${token}/decline`, { reason: 'Chose another vendor' });
    expect(res.status).toBe(200);
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('declined');
    expect(q!.declineReason).toBe('Chose another vendor');
    // The token is consumed on decline → re-decline resolves to 401 (revoked link).
    const again = await postJson(`/quotes/public/${token}/decline`, { reason: 'oops' });
    expect(again.status).toBe(401);
  });

  // Phase 3 read-time expiry guard on the public paths: a quote past its
  // expiry_date can be neither accepted nor declined, even before the sweep runs.
  runDb('POST accept on an expired quote → 410 QUOTE_EXPIRED, no conversion', async () => {
    const { quoteId, token } = await seedQuote({ lines: [{ description: 'Setup', unitPrice: '250.00' }] });
    await withSystemDbAccessContext(() => db.update(quotes).set({ expiryDate: '2000-01-01' }).where(eq(quotes.id, quoteId)));
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Late Larry' });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'QUOTE_EXPIRED' });
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('sent'); // unchanged — not converted
  });

  runDb('POST decline on an expired quote → 410 QUOTE_EXPIRED', async () => {
    const { quoteId, token } = await seedQuote();
    await withSystemDbAccessContext(() => db.update(quotes).set({ expiryDate: '2000-01-01' }).where(eq(quotes.id, quoteId)));
    const res = await postJson(`/quotes/public/${token}/decline`, { reason: 'too late' });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'QUOTE_EXPIRED' });
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('sent'); // unchanged — not declined
  });

  runDb('POST accept converts, then the single-use token can no longer view or accept', async () => {
    const { quoteId, token } = await seedQuote({ lines: [{ description: 'Setup', unitPrice: '250.00' }] });
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Prospect Pat' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string } };
    expect(body.data.status).toBe('converted');
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('converted');
    expect(q!.convertedInvoiceId).toBeTruthy();
    // Token revoked post-accept → replay is blocked at the resolve() gate (401, not 409).
    expect((await app().request(`/quotes/public/${token}`)).status).toBe(401);
    expect((await postJson(`/quotes/public/${token}/accept`, { signerName: 'Replay' })).status).toBe(401);
  });

  // #2875: the durable response-capability columns (2026-08-06-c) are written in
  // the same transaction as the accept, and act as a replay backstop that holds
  // even when the Redis jti-revocation marker is lost (flush/failover/TTL).
  runDb('POST accept consumes the durable response capability; replay is 401 even after the Redis marker is lost', async () => {
    const { quoteId, token } = await seedQuote({ lines: [{ description: 'Setup', unitPrice: '250.00' }] });
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Prospect Pat' });
    expect(res.status).toBe(200);
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.publicResponseJti).toBeTruthy();
    expect(q!.publicResponseConsumedAt).toBeTruthy();
    expect(q!.publicResponseOutcome).toBe('accepted');
    // Simulate a Redis flush: delete the jti revocation marker outright.
    const redis = getRedis();
    expect(redis).toBeTruthy();
    await redis!.del(`quote-accept-jti-revoked:${q!.publicResponseJti}`);
    // Replay passes the resolve() gate (marker gone) but the durable backstop
    // still rejects it — 401 (same shape as the Redis path), quote untouched.
    const replay = await postJson(`/quotes/public/${token}/accept`, { signerName: 'Replay Ray' });
    expect(replay.status).toBe(401);
    // Cross-route: a decline replay of the consumed accept link is 401 too.
    await redis!.del(`quote-accept-jti-revoked:${q!.publicResponseJti}`); // backstop re-armed the marker — drop it again
    expect((await postJson(`/quotes/public/${token}/decline`, { reason: 'flip' })).status).toBe(401);
    const [q2] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q2!.status).toBe('converted');
    expect(q2!.publicResponseOutcome).toBe('accepted');
  });

  runDb('POST decline consumes the durable response capability; replay (decline OR accept) is 401 even after the Redis marker is lost', async () => {
    const { quoteId, token } = await seedQuote({ lines: [{ description: 'Setup', unitPrice: '250.00' }] });
    const res = await postJson(`/quotes/public/${token}/decline`, { reason: 'Budget cut' });
    expect(res.status).toBe(200);
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.status).toBe('declined');
    expect(q!.publicResponseJti).toBeTruthy();
    expect(q!.publicResponseConsumedAt).toBeTruthy();
    expect(q!.publicResponseOutcome).toBe('declined');
    // Simulate a Redis flush, then replay both mutation routes.
    const redis = getRedis();
    expect(redis).toBeTruthy();
    await redis!.del(`quote-accept-jti-revoked:${q!.publicResponseJti}`);
    expect((await postJson(`/quotes/public/${token}/decline`, { reason: 'again' })).status).toBe(401);
    // The backstop re-arms the Redis marker on a replay — drop it again so the
    // cross-route accept replay below also proves the DURABLE path, not Redis.
    await redis!.del(`quote-accept-jti-revoked:${q!.publicResponseJti}`);
    expect((await postJson(`/quotes/public/${token}/accept`, { signerName: 'Flip Flop' })).status).toBe(401);
    const [q2] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    expect(q2!.status).toBe('declined');
    expect(q2!.declineReason).toBe('Budget cut');
  });

  runDb('POST accept requires a signer name (zValidator 400)', async () => {
    const { token } = await seedQuote({ lines: [{ description: 'Setup', unitPrice: '250.00' }] });
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: '' });
    expect(res.status).toBe(400);
  });
});
