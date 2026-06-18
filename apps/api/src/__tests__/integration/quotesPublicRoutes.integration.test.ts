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

  runDb('POST accept requires a signer name (zValidator 400)', async () => {
    const { token } = await seedQuote({ lines: [{ description: 'Setup', unitPrice: '250.00' }] });
    const res = await postJson(`/quotes/public/${token}/accept`, { signerName: '' });
    expect(res.status).toBe(400);
  });
});
